// HTTP 应用工厂：保留原有建档/任务/状态/备注流程，新增多索联调能力。
// createApp(store, { now }) 返回 http server，便于测试注入存储与时钟。
import http from "node:http";
import { JsonStore } from "./store.js";
import { planAdjustment, fingerprint, validateRopes, AdjustmentError } from "./adjustment.js";
import { page } from "./page.js";

export const seed = {
  schemaVersion: 3,
  items: [
    {
      id: "MR-SEED-001",
      code: "MR-001",
      version: 1,
      ropes: [],
      plans: [],
      lastSafeResult: null,
      shipType: "福船",
      scale: "1:48",
      mastCount: 3,
      riggingMaterial: "蜡线",
      owner: "周宁",
      ownerToken: "zhouning",
      dueDate: "2026-06-28",
      status: "校准中",
      tasks: [
        { id: "T-1", position: "前桅侧支索", tension: "偏松", status: "调整中", logs: [{ at: "2026-06-12", note: "已缩短2mm" }] },
      ],
      logs: [],
    },
  ],
};

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

export const migrations = [
  {
    version: 1,
    up(db) {
      for (const item of db.items || []) {
        if (!item.id) item.id = "MR-" + Math.abs(hashCode(item.code || JSON.stringify(item))).toString(36) + "v1";
      }
      return db;
    },
  },
  {
    version: 2,
    up(db) {
      for (const item of db.items || []) {
        item.version = item.version ?? 1;
        item.ropes = item.ropes ?? [];
        item.plans = item.plans ?? [];
        item.lastSafeResult = item.lastSafeResult ?? null;
      }
      return db;
    },
  },
  {
    version: 3,
    up(db) {
      for (const item of db.items || []) {
        if (!item.ownerToken && item.owner) {
          item.ownerToken = /^[\x20-\x7e]+$/.test(String(item.owner))
            ? item.owner
            : "u" + Buffer.from(String(item.owner), "utf8").toString("hex");
        }
        if (!item.ownerToken) item.ownerToken = "";
      }
      return db;
    },
  },
];

export const fields = [["code", "模型编号", "text"], ["shipType", "船型", "text"], ["scale", "比例", "text"], ["mastCount", "桅杆数量", "number"], ["riggingMaterial", "帆索材料", "text"], ["owner", "负责人", "text"], ["dueDate", "交付日期", "date"]];
export const stages = ["待检查", "校准中", "待复核", "已交付"];
const statLabels = ["待检查", "校准中", "待复核", "已交付"];

export function createApp(store, { now = () => new Date() } = {}) {
  const applyingPlanIds = new Set();

  function send(res, status, data) {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data, null, 2));
  }
  function httpError(status, error, message, extra = {}) {
    const e = new Error(message);
    e.status = status; e.error = error; e.extra = extra;
    return e;
  }
  async function body(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (!chunks.length) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw httpError(400, "bad_json", "请求体不是合法 JSON");
    }
  }
  function newId(prefix) { return prefix + now().getTime() + "-" + Math.random().toString(36).slice(2, 7); }
  // X-Operator 为百分号编码的操作员令牌（HTTP 头不允许非 ISO-8859-1）；X-Operator-Name 仅作显示名
  const operatorOf = req => {
    const raw = String(req.headers["x-operator"] ?? "").trim();
    if (!raw) return "";
    try { return decodeURIComponent(raw); } catch { return raw; }
  };
  function authorize(item, operator) {
    if (!operator) throw httpError(403, "forbidden", "缺少操作员身份（X-Operator 请求头），拒绝操作");
    const ownerToken = item.ownerToken || asciiToken(item.owner);
    if (ownerToken && ownerToken !== operator) {
      throw httpError(403, "forbidden", `越权请求：该模型由 ${item.owner || ownerToken} 负责，操作员 ${operator} 无权操作`);
    }
  }
  function asciiToken(name) {
    // 中文显示名 -> 稳定 ASCII 令牌（用于旧数据与建档时只给中文名的情况）；空负责人表示不限权
    if (!name) return "";
    if (/^[\x20-\x7e]+$/.test(name)) return name;
    return "u" + Buffer.from(String(name), "utf8").toString("hex");
  }
  function findItem(db, key) {
    const item = db.items.find(x => x.id === key || x.code === key);
    if (!item) throw httpError(404, "item_not_found", `未找到模型 ${key}`);
    return item;
  }
  // 严格数值：只接受有限 number 与非空数字字符串；拒绝 undefined/null/空串/布尔/非数字
  function strictNumber(value, field) {
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw httpError(400, "bad_request", `${field} 必须是有效数值`);
      return value;
    }
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    throw httpError(400, "bad_request", `${field} 必须是有效数值，空值/空字符串不被接受`);
  }
  // 建档等写入接口不得携带这些系统保留字段
  const RESERVED_FIELDS = ["id", "version", "ropes", "plans", "lastSafeResult", "tasks", "logs"];
  function rejectReserved(input) {
    const hit = RESERVED_FIELDS.find(k => k in (input || {}));
    if (hit) throw httpError(400, "reserved_field", `请求包含受保护字段 "${hit}"，该字段由系统维护，拒绝写入`);
  }
  function computeStats(items) {
    const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
    for (const item of items) if (stats[item.status] !== undefined) stats[item.status] += 1;
    return stats;
  }
  function summarize(item) {
    const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
    const { ownerToken, ...rest } = item; // 令牌绝不随响应下发
    return { ...rest, logCount };
  }
  // 无鉴权的列表视图：剥离联调敏感数据（索集合/方案/上次安全结果），仅保留原流程所需字段
  function listView(item) {
    return Object.fromEntries(Object.entries(summarize(item)).filter(([k]) =>
      !["ropes", "plans", "lastSafeResult"].includes(k)));
  }
  function pushLog(item, step, note) {
    item.logs ||= [];
    item.logs.push({ at: now().toISOString(), step, note });
  }
  const bump = item => { item.version = (item.version ?? 1) + 1; };

  function normalizeRope(r) {
    return {
      id: String(r.id),
      name: String(r.name ?? r.id),
      tension: strictNumber(r.tension, `索 ${r.id} 当前张力`),
      min: strictNumber(r.min, `索 ${r.id} 安全下限`),
      max: strictNumber(r.max, `索 ${r.id} 安全上限`),
      influence: Object.fromEntries(Object.entries(r.influence ?? {}).map(([k, v]) =>
        [String(k), strictNumber(v, `索 ${r.id} 对 ${k} 的影响系数`)])),
    };
  }
  // 对原始登记输入做空值级校验（在 normalize 之前，避免空串被 Number() 转成 0）
  function validateRopePayload(input) {
    if (!Array.isArray(input.ropes) || !input.ropes.length) {
      throw httpError(400, "bad_request", "ropes 必须是非空数组");
    }
    for (const r of input.ropes) {
      if (!r || typeof r !== "object") throw httpError(400, "bad_request", "每根索必须是对象");
      const id = String(r.id ?? "").trim();
      if (!id) throw httpError(400, "bad_request", "索 id 不能为空");
      strictNumber(r.tension, `索 ${id} 当前张力`);
      strictNumber(r.min, `索 ${id} 安全下限`);
      strictNumber(r.max, `索 ${id} 安全上限`);
      for (const [k, v] of Object.entries(r.influence ?? {})) {
        if (!String(k).trim()) throw httpError(400, "bad_request", `索 ${id} 的影响系数键不能为空`);
        strictNumber(v, `索 ${id} 对 ${k} 的影响系数`);
      }
    }
  }
  function validateRopeInput(ropes) {
    try {
      validateRopes(ropes);
    } catch (e) {
      if (e instanceof AdjustmentError) throw httpError(422, e.code, e.message);
      throw e;
    }
  }
  function computePlan(item, targets) {
    if (!Array.isArray(targets) || !targets.length) throw httpError(400, "bad_request", "targets 必须是非空数组");
    for (const t of targets) {
      if (!t || typeof t !== "object") throw httpError(400, "bad_request", "targets 每项必须是对象");
      if (t.id == null || String(t.id).trim() === "") throw httpError(400, "bad_request", "目标索 id 不能为空");
      // 严格数值：空串/空值/布尔一律拒绝（Number("")===0 的隐式转换不得放行）
      t.target = strictNumber(t.target, `索 ${t.id} 的目标张力`);
      t.id = String(t.id).trim();
    }
    if (!item.ropes?.length) throw httpError(422, "ropes_empty", "尚未登记任何索，无法联调");
    const result = planAdjustment(item.ropes, targets);
    return {
      selected: result.selected,
      steps: result.steps,
      adjustments: result.adjustments,
      exactAdjustments: result.exactAdjustments,
      finalTensions: result.finalTensions,
      converged: result.converged,
      sweeps: result.sweeps,
      residual: result.residual,
      risks: result.risks,
      blockers: result.blockers,
    };
  }
  function presentPlan(item, plan) {
    return {
      id: plan.id,
      status: plan.status,
      baseVersion: plan.baseVersion,
      currentVersion: item.version,
      targets: plan.targets,
      selected: plan.selected,
      converged: plan.converged,
      sweeps: plan.sweeps,
      residual: plan.residual,
      adjustments: plan.adjustments,
      exactAdjustments: plan.exactAdjustments,
      finalTensions: plan.finalTensions,
      steps: plan.steps,
      risks: plan.risks ?? [],
      blockers: plan.blockers ?? [],
      createdAt: plan.createdAt,
      appliedAt: plan.appliedAt ?? null,
    };
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      const db = await store.read();

      // ---------- 页面 ----------
      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end(page());
      }

      // ---------- 原有流程（只读部分保持不变） ----------
      if (req.method === "GET" && url.pathname === "/api/items") {
        return send(res, 200, db.items.map(listView));
      }
      if (req.method === "GET" && url.pathname === "/api/stats") {
        return send(res, 200, computeStats(db.items));
      }

      // 原 建档（保留：无鉴权，行为与旧版一致，新增联调字段）
      if (req.method === "POST" && url.pathname === "/api/items") {
        const input = await body(req);
        rejectReserved(input); // 建档不得覆盖版本/索集合/方案/日志等系统字段
        const item = await store.mutate(d => {
          const it = {
            id: newId("MR-"),
            version: 1,
            ropes: [],
            plans: [],
            lastSafeResult: null,
            ...input,
            tasks: [],
            logs: [{ at: now().toISOString(), step: "建档", note: "创建模型" }],
          };
          it.ownerToken = input.ownerToken || operatorOf(req) || asciiToken(input.owner) || "";
          d.items.unshift(it);
          return it;
        });
        return send(res, 201, item);
      }

      const detail = url.pathname.match(/^\/api\/items\/([^/]+)$/);
      if (detail && req.method === "GET") {
        const item = findItem(db, decodeURIComponent(detail[1]));
        authorize(item, operatorOf(req)); // 联调详情（含索集合/版本/安全结果）需操作员且不得越权
        return send(res, 200, summarize(item));
      }
      // 原 状态变更（保留）
      if (detail && req.method === "PATCH") {
        const key = decodeURIComponent(detail[1]);
        const input = await body(req);
        const item = await store.mutate(d => {
          const it = findItem(d, key);
          if ("status" in input) it.status = input.status;
          pushLog(it, "状态", "更新为" + it.status);
          bump(it);
          return it;
        });
        return send(res, 200, summarize(item));
      }

      const logPath = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
      if (logPath && req.method === "POST") {
        const key = decodeURIComponent(logPath[1]);
        const input = await body(req);
        const item = await store.mutate(d => {
          const it = findItem(d, key);
          pushLog(it, input.step || "记录", input.note || "");
          bump(it);
          return it;
        });
        return send(res, 201, summarize(item));
      }

      const actionPath = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
      if (actionPath && req.method === "POST") {
        const key = decodeURIComponent(actionPath[1]);
        const input = await body(req);
        const item = await store.mutate(d => {
          const it = findItem(d, key);
          it.tasks ||= [];
          it.tasks.push({ id: "T-" + now().getTime(), position: input.position, tension: input.tension, status: "待检查", logs: [{ at: now().toISOString(), note: input.note || "新增帆索任务" }] });
          it.status = "校准中";
          pushLog(it, "帆索", input.position + " · " + input.tension);
          bump(it);
          return it;
        });
        return send(res, 201, summarize(item));
      }

      // ---------- 联调：索登记 ----------
      const ropesPath = url.pathname.match(/^\/api\/items\/([^/]+)\/ropes$/);
      if (ropesPath) {
        const key = decodeURIComponent(ropesPath[1]);
        if (req.method === "POST") {
          const operator = operatorOf(req);
          const input = await body(req);
          validateRopePayload(input); // 空值/空串/结构异常在此拒绝，原数据不动
          const clean = input.ropes.map(normalizeRope);
          const item = await store.mutate(d => {
            const it = findItem(d, key);
            authorize(it, operator);
            const existing = Array.isArray(it.ropes) ? it.ropes : [];
            // 校验合并后的完整索集合（影响系数可引用此前已登记的索）；异常则整批拒绝、原记录不动
            const byId = new Map(existing.map(r => [r.id, r]));
            for (const r of clean) byId.set(r.id, r);
            validateRopeInput([...byId.values()]);
            it.ropes = [...byId.values()];
            bump(it);
            pushLog(it, "索登记", `登记/更新 ${clean.length} 根索，当前共 ${it.ropes.length} 根`);
            return it;
          });
          return send(res, 200, { version: item.version, ropes: item.ropes });
        }
      }

      // ---------- 联调：方案 ----------
      const plansPath = url.pathname.match(/^\/api\/items\/([^/]+)\/plans$/);
      if (plansPath && req.method === "GET") {
        const item = findItem(db, decodeURIComponent(plansPath[1]));
        authorize(item, operatorOf(req)); // 方案列表含调节明细，需操作员且不得越权
        return send(res, 200, item.plans.map(p => presentPlan(item, p)));
      }
      if (plansPath && req.method === "POST") {
        const key = decodeURIComponent(plansPath[1]);
        const operator = operatorOf(req);
        const input = await body(req);
        const targets = input.targets;
        const fp = fingerprint({ version: null, targets }); // 指纹看目标集合；版本另存
        const { item, plan, idempotent } = await store.mutate(d => {
          const it = findItem(d, key);
          authorize(it, operator);
          const calc = computePlan(it, targets); // 输入/算法结构异常抛 400/422，不落任何记录
          if (calc.blockers.length) {
            // 越界/无解/不收敛：拒绝且原记录不动（方案与日志均不落盘）
            throw httpError(422, "plan_blocked", "方案存在阻塞，已拒绝，原记录未改动", { preview: calc });
          }
          const existing = it.plans.find(p =>
            p.status === "draft" && p.baseVersion === it.version && p.fingerprint === fp);
          if (existing) return { item: it, plan: existing, idempotent: true };
          const p = {
            id: newId("PL-"),
            fingerprint: fp,
            baseVersion: it.version,
            targets: targets.map(t => ({ id: t.id, target: t.target })),
            operator,
            createdAt: now().toISOString(),
            status: "draft",
            ...calc,
          };
          it.plans.push(p);
          pushLog(it, "方案预览", `${p.id}：可执行（${targets.length} 根目标索，版本 v${it.version}，${calc.risks.length} 条风险提示）`);
          return { item: it, plan: p, idempotent: false };
        });
        return send(res, idempotent ? 200 : 201, presentPlan(item, plan));
      }

      // ---------- 联调：应用 ----------
      const applyPath = url.pathname.match(/^\/api\/items\/([^/]+)\/plans\/([^/]+)\/apply$/);
      if (applyPath && req.method === "POST") {
        const key = decodeURIComponent(applyPath[1]);
        const planId = decodeURIComponent(applyPath[2]);
        const operator = operatorOf(req);
        const input = await body(req).catch(() => ({}));
        if (applyingPlanIds.has(planId)) {
          return send(res, 409, { error: "plan_locked", message: "方案正在被另一个请求应用（并发只允许一次成功），请查询现有结果" });
        }
        applyingPlanIds.add(planId);
        try {
          const out = await store.mutate(d => {
            const it = findItem(d, key);
            authorize(it, operator);
            const plan = it.plans.find(p => p.id === planId);
            if (!plan) throw httpError(404, "plan_not_found", `未找到方案 ${planId}`);
            if (plan.status === "applied") return { idempotent: true, item: it, plan };
            if (plan.status === "undone") throw httpError(409, "plan_undone", "方案已撤销，不能再次应用");
            if (plan.baseVersion !== it.version) {
              throw httpError(409, "version_conflict",
                `方案基于过期版本 v${plan.baseVersion}，当前为 v${it.version}，请重新预览`,
                { baseVersion: plan.baseVersion, currentVersion: it.version });
            }
            if ("expectedVersion" in input && Number(input.expectedVersion) !== it.version) {
              throw httpError(409, "version_conflict",
                `请求要求版本 v${input.expectedVersion}，当前为 v${it.version}`,
                { baseVersion: Number(input.expectedVersion), currentVersion: it.version });
            }
            if (plan.blockers?.length) {
              throw httpError(422, "plan_blocked", "方案存在阻塞，拒绝应用", { blockers: plan.blockers, risks: plan.risks });
            }
            const recomputed = computePlan(it, plan.targets);
            if (recomputed.blockers.length) {
              throw httpError(422, "plan_blocked", "应用前复算不再安全，拒绝应用", { blockers: recomputed.blockers });
            }
            const tensionsBefore = it.ropes.map(r => ({ id: r.id, tension: r.tension }));
            const byId = new Map(it.ropes.map(r => [r.id, r]));
            for (const [id, value] of Object.entries(plan.finalTensions)) {
              const rp = byId.get(id);
              if (rp) rp.tension = value;
            }
            plan.status = "applied";
            plan.appliedAt = now().toISOString();
            it.lastSafeResult = {
              planId: plan.id,
              appliedAt: plan.appliedAt,
              tensionsBefore,
              finalTensions: plan.finalTensions,
              undoable: true,
            };
            pushLog(it, "联调应用", `${plan.id}：调节 ${plan.selected.join("、")}，终值全部位于安全区间`);
            bump(it);
            return { idempotent: false, item: it, plan };
          });
          return send(res, 200, {
            idempotent: out.idempotent,
            version: out.item.version,
            plan: presentPlan(out.item, out.plan),
            lastSafeResult: out.item.lastSafeResult,
          });
        } finally {
          applyingPlanIds.delete(planId);
        }
      }

      // ---------- 联调：撤销上次安全结果 ----------
      const undoPath = url.pathname.match(/^\/api\/items\/([^/]+)\/plans\/([^/]+)\/undo$/);
      if (undoPath && req.method === "POST") {
        const key = decodeURIComponent(undoPath[1]);
        const planId = decodeURIComponent(undoPath[2]);
        const operator = operatorOf(req);
        const item = await store.mutate(d => {
          const it = findItem(d, key);
          authorize(it, operator);
          const plan = it.plans.find(p => p.id === planId);
          if (!plan) throw httpError(404, "plan_not_found", `未找到方案 ${planId}`);
          if (!it.lastSafeResult || it.lastSafeResult.planId !== planId) {
            throw httpError(409, "undo_conflict", "只能撤销最近一次安全应用结果；该方案不是最近一次应用或尚未应用");
          }
          if (it.lastSafeResult.undoable !== true) {
            throw httpError(409, "undo_conflict", "该安全结果已撤销，重复撤销被拒绝，版本不推进");
          }
          const byId = new Map(it.ropes.map(r => [r.id, r]));
          for (const b of it.lastSafeResult.tensionsBefore) {
            const rp = byId.get(b.id);
            if (rp) rp.tension = b.tension;
          }
          plan.status = "undone";
          it.lastSafeResult.undoable = false;
          it.lastSafeResult.undoneAt = now().toISOString();
          pushLog(it, "联调撤销", `${planId}：张力恢复到应用前`);
          bump(it);
          return it;
        });
        return send(res, 200, { version: item.version, lastSafeResult: item.lastSafeResult, ropes: item.ropes });
      }

      // 测试故障注入
      if (req.method === "POST" && url.pathname === "/api/_test/fault" && process.env.ALLOW_FAULT === "1") {
        const input = await body(req);
        store.failNextWrites = Math.max(0, Number(input.failNextWrites) || 0);
        return send(res, 200, { ok: true, failNextWrites: store.failNextWrites });
      }

      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (error.status) return send(res, error.status, { error: error.error, message: error.message, ...error.extra });
      send(res, 500, { error: "internal_error", message: error.message });
    }
  };

  return http.createServer(handler);
}

export function defaultStore(dbPath) {
  return new JsonStore(dbPath, seed, migrations);
}
