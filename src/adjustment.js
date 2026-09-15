// 多索联调核心算法：数据校验、影响系数线性求解、逐步调节模拟、收敛判定、安全区间检查。
// 纯函数、无 IO，便于单元测试。

export const TOLERANCE = 0.01; // 张力残差收敛阈值（N）
export const MAX_SWEEPS = 60; // 逐根调节最多扫掠轮数
export const NEAR_LIMIT_RATIO = 0.05; // 距安全区间边界 5% 视为风险
export const ROUND = 2; // 张力/调节量保留两位小数

export class AdjustmentError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdjustmentError";
    this.code = code;
    Object.assign(this, details);
  }
}

const isNum = v => typeof v === "number" && Number.isFinite(v);

function round2(v) {
  return Math.round(v * 10 ** ROUND) / 10 ** ROUND;
}

/**
 * 校验并归一化索登记数据。
 * 入参索对象：{ id, name, tension, min, max, influence: { [其他索id]: 系数 } }
 * 结构异常直接抛 AdjustmentError（data_anomaly）；当前张力超出安全区间不抛错（偏松/偏紧本就需要调整）。
 * 返回 { ids, ropes, A }，A 为以 ids 为序的全量影响系数方阵，对角缺省为 1。
 */
export function validateRopes(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new AdjustmentError("data_anomaly", "至少需要登记一根索");
  }
  const ids = [];
  const ropes = new Map();
  for (const r of input) {
    if (!r || typeof r !== "object") {
      throw new AdjustmentError("data_anomaly", "索数据格式错误");
    }
    const id = String(r.id ?? "").trim();
    if (!id) throw new AdjustmentError("data_anomaly", "索缺少标识 id");
    if (ids.includes(id)) throw new AdjustmentError("data_anomaly", `索标识重复：${id}`);
    for (const k of ["tension", "min", "max"]) {
      if (!isNum(r[k])) throw new AdjustmentError("data_anomaly", `索 ${id} 的 ${k} 不是有效数值`);
    }
    if (r.min >= r.max) {
      throw new AdjustmentError("data_anomaly", `索 ${id} 的安全区间非法（下限须小于上限）`);
    }
    const influence = {};
    const raw = r.influence && typeof r.influence === "object" ? r.influence : {};
    for (const [k, v] of Object.entries(raw)) {
      if (!isNum(v)) throw new AdjustmentError("data_anomaly", `索 ${id} 对 ${k} 的影响系数不是有效数值`);
      influence[String(k)] = v;
    }    ids.push(id);
    ropes.set(id, {
      id,
      name: String(r.name ?? id),
      tension: r.tension,
      min: r.min,
      max: r.max,
      influence,
    });
  }
  // 影响系数引用的索必须存在；构建全量方阵
  for (const id of ids) {
    for (const ref of Object.keys(ropes.get(id).influence)) {
      if (!ids.includes(ref)) {
        throw new AdjustmentError("data_anomaly", `索 ${id} 的影响系数引用了未知索 ${ref}`);
      }
    }
  }
  const A = ids.map(i =>
    ids.map(j => {
      const rp = ropes.get(i);
      if (j === i) return rp.influence[j] ?? 1;
      return rp.influence[j] ?? 0;
    })
  );
  for (let i = 0; i < ids.length; i++) {
    // 校验在第二次遍历时补查未知引用（上面已直接抛错，这里保留对角检查）
    if (Math.abs(A[i][i]) < 1e-9) {
      throw new AdjustmentError("data_anomaly", `索 ${ids[i]} 的自影响系数为 0，模型奇异`);
    }
  }
  return { ids, ropes, A };
}

/** 高斯消元（列主元）解线性方程组 Mx=b。返回 { x, singular, inconsistent }。 */
export function solveLinear(M, b) {
  const n = M.length;
  const a = M.map((row, i) => [...row.map(Number), Number(b[i])]);
  const scale = Math.max(1, ...a.flat().map(v => Math.abs(v)));
  const pivotCol = new Array(n).fill(-1);
  let row = 0;
  for (let col = 0; col < n && row < n; col++) {
    let piv = row;
    for (let k = row + 1; k < n; k++) {
      if (Math.abs(a[k][col]) > Math.abs(a[piv][col])) piv = k;
    }
    if (Math.abs(a[piv][col]) < 1e-9 * scale) continue;
    [a[row], a[piv]] = [a[piv], a[row]];
    for (let k = 0; k < n; k++) {
      if (k === row) continue;
      const f = a[k][col] / a[row][col];
      if (f !== 0) for (let c = col; c <= n; c++) a[k][c] -= f * a[row][c];
    }
    pivotCol[row] = col;
    row++;
  }
  let inconsistent = false;
  for (let k = row; k < n; k++) {
    if (Math.abs(a[k][n]) > 1e-6 * scale) inconsistent = true;
  }
  if (row < n) return { x: null, singular: true, inconsistent };
  const x = new Array(n).fill(0);
  for (let k = 0; k < n; k++) x[pivotCol[k]] = a[k][n] / a[k][pivotCol[k]];
  return { x, singular: false, inconsistent: false };
}

function norm(v) {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

/**
 * 计算多索联调方案（纯计算，不落库、不抛业务异常——blockers 随结果返回）。
 * @param ropes 已登记索数组
 * @param targets [{ id, target }] 选中的目标索及其目标张力
 * @returns {
 *   selected, steps[], finalTensions{}, adjustments{}, converged, sweeps, residual,
 *   risks[], blockers[]
 * }
 * 出现 blockers 时调用方必须拒绝；原记录不动。
 */
export function planAdjustment(rawRopes, rawTargets, opts = {}) {
  const maxSweeps = opts.maxSweeps ?? MAX_SWEEPS;
  const tolerance = opts.tolerance ?? TOLERANCE;

  const blockers = [];
  const risks = [];

  let model;
  try {
    model = validateRopes(rawRopes);
  } catch (e) {
    if (e instanceof AdjustmentError) {
      return { blockers: [{ code: e.code, message: e.message }], risks: [], converged: false };
    }
    throw e;
  }
  const { ids, ropes, A } = model;

  // --- 目标校验 ---
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    return { blockers: [{ code: "data_anomaly", message: "未选择任何目标索" }], risks: [], converged: false };
  }
  const seen = new Set();
  for (const t of rawTargets) {
    if (!t || !isNum(t.target)) {
      blockers.push({ code: "data_anomaly", ropeId: String(t?.id ?? ""), message: "目标值不是有效数值" });
      continue;
    }
    const id = String(t.id);
    if (!ropes.has(id)) {
      blockers.push({ code: "unknown_rope", ropeId: id, message: `目标索 ${id} 未登记` });
      continue;
    }
    if (seen.has(id)) blockers.push({ code: "data_anomaly", ropeId: id, message: `目标索 ${id} 重复` });
    seen.add(id);
    const rp = ropes.get(id);
    if (t.target < rp.min - 1e-9 || t.target > rp.max + 1e-9) {
      blockers.push({ code: "target_out_of_range", ropeId: id, message: `索 ${id} 目标值 ${t.target} 超出安全区间 [${rp.min}, ${rp.max}]` });
    }
  }
  if (blockers.length) return { selected: [...seen], blockers, risks: [], converged: false };

  const selected = [...seen];
  const selIdx = selected.map(id => ids.indexOf(id));
  const t0 = ids.map(id => ropes.get(id).tension);

  // 当前张力已越界的索 → 风险（这正是要校准的原因）
  for (const id of ids) {
    const rp = ropes.get(id);
    if (rp.tension < rp.min - 1e-9 || rp.tension > rp.max + 1e-9) {
      risks.push({ code: "current_out_of_range", ropeId: id, message: `索 ${id} 当前张力 ${rp.tension} 已在安全区间外，调节过程中须重点监控` });
    }
  }

  // --- 精确解：选中索的调节量 x* ---
  const M = selIdx.map(i => selIdx.map(j => A[i][j]));
  const rhs = selIdx.map(i => {
    const tid = selected[selIdx.indexOf(i)];
    return rawTargets.find(t => String(t.id) === tid).target - ropes.get(ids[i]).tension;
  });
  const solved = solveLinear(M, rhs);
  if (solved.singular) {
    blockers.push({
      code: solved.inconsistent ? "no_solution" : "singular_matrix",
      message: solved.inconsistent
        ? "影响系数矩阵下目标无解：调节这些索无法同时达到所选目标值"
        : "影响系数矩阵奇异：存在联动冗余，目标值不能唯一确定",
    });
    return { selected, blockers, risks, converged: false };
  }
  const xStar = solved.x;

  // --- 预测终值（全量索，含联动） ---
  const finalAll = t0.map((t, r) => t + selIdx.reduce((s, j, k) => s + A[r][j] * xStar[k], 0));
  for (let r = 0; r < ids.length; r++) {
    const rp = ropes.get(ids[r]);
    const v = finalAll[r];
    if (v < rp.min - tolerance || v > rp.max + tolerance) {
      blockers.push({ code: "final_out_of_range", ropeId: ids[r], message: `索 ${ids[r]} 预测终值 ${round2(v)} 超出安全区间 [${rp.min}, ${rp.max}]` });
    } else {
      const span = rp.max - rp.min;
      if (v - rp.min < NEAR_LIMIT_RATIO * span || rp.max - v < NEAR_LIMIT_RATIO * span) {
        risks.push({ code: "near_limit", ropeId: ids[r], message: `索 ${ids[r]} 预测终值 ${round2(v)} 贴近安全区间边界` });
      }
    }
  }

  // --- 逐步模拟：每次只调一根索（Gauss-Seidel 扫掠），观察联动轨迹 ---
  const t = [...t0];
  const steps = [];
  const startResidual = norm(selIdx.map(i => rhs[selIdx.indexOf(i)]));
  let converged = false;
  let sweeps = 0;
  let trajectoryBlocked = false;

  const snapshot = () => Object.fromEntries(ids.map((id, r) => [id, round2(t[r])]));
  // 轨迹边界：允许起始就在区间外（偏松/偏紧正是校准对象），但调节过程不得比起始更糟；
  // 一旦某根索回到区间内，此后不得再越出。终值必须落在安全区间（前面 finalAll 已检查）。
  const startLo = t0.map((v, r) => Math.min(ropes.get(ids[r]).min, v) - tolerance);
  const startHi = t0.map((v, r) => Math.max(ropes.get(ids[r]).max, v) + tolerance);
  const entered = t0.map((v, r) => v >= ropes.get(ids[r]).min - tolerance && v <= ropes.get(ids[r]).max + tolerance);
  const checkBounds = (stepNo) => {
    for (let r = 0; r < ids.length; r++) {
      const rp = ropes.get(ids[r]);
      const inside = t[r] >= rp.min - tolerance && t[r] <= rp.max + tolerance;
      if (inside) { entered[r] = true; continue; }
      if (entered[r] || t[r] < startLo[r] || t[r] > startHi[r]) {
        blockers.push({ code: "trajectory_out_of_range", ropeId: ids[r], step: stepNo, message: `第 ${stepNo} 步调节后，索 ${ids[r]} 张力 ${round2(t[r])} 越出允许轨迹（安全区间 [${rp.min}, ${rp.max}]）` });
        trajectoryBlocked = true;
        return;
      }
    }
  };

  for (sweeps = 0; sweeps < maxSweeps && !trajectoryBlocked; sweeps++) {
    for (let k = 0; k < selected.length; k++) {
      const row = selIdx[k];
      const gap = (() => {
        const tid = selected[k];
        return rawTargets.find(tt => String(tt.id) === tid).target - t[row];
      })();
      const dx = gap / A[row][row];
      if (!isNum(dx)) {
        blockers.push({ code: "data_anomaly", ropeId: selected[k], message: "逐步调节量计算出现非数值，拒绝执行" });
        trajectoryBlocked = true;
        break;
      }
      const col = selIdx[k];
      for (let r = 0; r < ids.length; r++) t[r] += A[r][col] * dx;
      steps.push({
        step: steps.length + 1,
        ropeId: selected[k],
        adjust: round2(dx),
        tensions: snapshot(),
      });
      checkBounds(steps.length);
      if (trajectoryBlocked) break;
    }
    if (trajectoryBlocked) break;
    const residual = norm(selIdx.map((row, k) => {
      const tid = selected[k];
      return rawTargets.find(tt => String(tt.id) === tid).target - t[row];
    }));
    if (residual <= tolerance) {
      converged = true;
      break;
    }
    if (residual > Math.max(startResidual * 1e6, 1e9)) {
      blockers.push({ code: "not_converged", message: "逐根调节时残差发散，联动导致反复振荡" });
      trajectoryBlocked = true; // 借标志终止
      break;
    }
  }
  if (!converged && !trajectoryBlocked) {
    blockers.push({ code: "not_converged", message: `${maxSweeps} 轮逐根调节后仍未收敛到目标（残差阈值 ${tolerance}）` });
  }

  // 越界信息补充被调节索
  for (const b of blockers) {
    if (b.code === "trajectory_out_of_range" && b.step) {
      const st = steps[b.step - 1];
      if (st) b.message = `第 ${b.step} 步调节 ${st.ropeId} 时，索 ${b.ropeId} 张力越界`;
    }
  }

  const adjustments = {};
  for (let k = 0; k < selected.length; k++) {
    // 每根索的总调节量 = 模拟中该索各步 adjust 之和（与精确解一致）
    adjustments[selected[k]] = round2(
      steps.filter(s => s.ropeId === selected[k]).reduce((s, st) => s + st.adjust, 0)
    );
  }
  const finalTensions = Object.fromEntries(ids.map((id, r) => [id, round2(finalAll[r])]));
  const residual = converged
    ? norm(selIdx.map((row, k) => {
        const tid = selected[k];
        return rawTargets.find(tt => String(tt.id) === tid).target - t[row];
      }))
    : null;

  return {
    selected,
    steps,
    adjustments,
    finalTensions,
    converged: converged && !blockers.length,
    sweeps: sweeps + 1,
    residual: residual === null ? null : round2(residual),
    exactAdjustments: Object.fromEntries(selected.map((id, k) => [id, round2(xStar[k])])),
    risks,
    blockers,
  };
}

/** 方案指纹：同一组索版本 + 目标 + 选中集合重复预览视为同一方案。 */
export function fingerprint({ version, targets }) {
  const canon = JSON.stringify({
    version,
    targets: targets.map(t => [String(t.id), Number(t.target).toFixed(4)]).sort((a, b) => a[0].localeCompare(b[0])),
  });
  return Buffer.from(canon).toString("base64url");
}
