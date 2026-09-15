// 写接口请求体反例：空体/空对象/null/缺字段/类型错误一律 400，且原数据、版本、磁盘内容不变。
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setupServer, seedItem, registerSample, TOKEN } from "./helpers.js";

let env;
before(async () => { env = await setupServer(); });
after(async () => { await env.cleanup(); });

const H = { "X-Operator": TOKEN };

// 准备一个可联调的模型并登记两根索
async function readyModel() {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id, [
    { id: "R1", tension: 50, min: 30, max: 80, influence: {} },
    { id: "R2", tension: 40, min: 20, max: 70, influence: { R1: 0.2 } },
  ]);
  return item;
}

// 对一组反例逐一断言 400，并断言模型版本与磁盘文件字节不变
async function expectRejected(path, bodies, { method = "POST", headers = H } = {}) {
  const before = await readFile(env.dbPath, "utf8");
  for (const body of bodies) {
    const r = await env.call(method, path, body, headers);
    assert.equal(r.status, 400, `${method} ${path} body=${JSON.stringify(body)} 期望 400，实际 ${r.status} ${JSON.stringify(r.data).slice(0, 160)}`);
    assert.equal(r.data.error, "bad_request", JSON.stringify(r.data));
  }
  const after = await readFile(env.dbPath, "utf8");
  assert.equal(after, before, "被拒绝的写请求不得改动磁盘文件");
}

test("建档：空体/空对象/null/数组/标量/缺 code/类型错误全部 400，且不新增模型", async () => {
  const before = (await env.call("GET", "/api/items", undefined, { "X-Operator": "" })).data.length;
  await expectRejected("/api/items", [
    undefined, {}, null, [], "x", 42,
    { shipType: "福船" },                       // 缺 code
    { code: 123 },                              // code 非字符串
    { code: "C1", shipType: 9 },                // 字段类型错误
    { code: "C1", owner: 5 },
    { code: "C1", mastCount: "abc" },
    { code: "C1", mastCount: null },
    { code: "C1", status: "不存在的状态" },
    { code: "C1", status: 7 },
  ], { headers: {} });
  const after = (await env.call("GET", "/api/items", undefined, { "X-Operator": "" })).data.length;
  assert.equal(after, before, "拒绝后模型数量不变");
});

test("状态变更：空体/空对象/null/缺 status/非法 status/多余字段全部 400，版本不变", async () => {
  const item = await seedItem(env.call);
  const v0 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  await expectRejected(`/api/items/${item.id}`, [
    undefined, {}, null, [], "x",
    { wrong: "x" },
    { status: "不存在" },
    { status: 7 },
    { status: "待复核", extra: 1 },
  ], { method: "PATCH", headers: {} });
  const v1 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  assert.equal(v1, v0);
});

test("备注：空体/空对象/null/缺 note/空 note/类型错误全部 400，版本不变", async () => {
  const item = await seedItem(env.call);
  const v0 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  const logCount0 = (await env.call("GET", `/api/items/${item.id}`)).data.logs.length;
  await expectRejected(`/api/items/${item.id}/logs`, [
    undefined, {}, null, [], 5,
    { step: "备注" },
    { note: "" },
    { note: "   " },
    { note: 7 },
    { note: "ok", step: 9 },
  ], { headers: {} });
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.version, v0);
  assert.equal(d.data.logs.length, logCount0);
});

test("帆索任务：空体/空对象/null/缺字段/类型错误全部 400，任务与版本不变", async () => {
  const item = await seedItem(env.call);
  const v0 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  await expectRejected(`/api/items/${item.id}/action`, [
    undefined, {}, null, [], "x",
    { tension: "偏松" },                        // 缺 position
    { position: "前桅支索" },                    // 缺 tension
    { position: "", tension: "偏松" },
    { position: "前桅支索", tension: "" },
    { position: 3, tension: "偏松" },
    { position: "前桅支索", tension: 5 },
    { position: "前桅支索", tension: "偏松", note: 1 },
  ], { headers: {} });
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.version, v0);
  assert.equal(d.data.tasks.length, 0);
});

test("索登记：空体/空对象/null/结构错误/缺字段/空值/类型错误全部 400，版本与索集合不变", async () => {
  const item = await readyModel();
  const v0 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  const n0 = (await env.call("GET", `/api/items/${item.id}`)).data.ropes.length;
  await expectRejected(`/api/items/${item.id}/ropes`, [
    undefined, {}, null, [], "x",
    { ropes: null },
    { ropes: "x" },
    { ropes: {} },
    { ropes: [] },
    { ropes: [null] },
    { ropes: ["x"] },
    { ropes: [5] },
    { ropes: [{ min: 30, max: 80 }] },                        // 缺 id
    { ropes: [{ id: "  ", tension: 50, min: 30, max: 80 }] },
    { ropes: [{ id: "R9", min: 30, max: 80 }] },             // 缺 tension
    { ropes: [{ id: "R9", tension: null, min: 30, max: 80 }] },
    { ropes: [{ id: "R9", tension: "", min: 30, max: 80 }] },
    { ropes: [{ id: "R9", tension: 50, max: 80 }] },         // 缺 min
    { ropes: [{ id: "R9", tension: 50, min: "x", max: 80 }] },
    { ropes: [{ id: "R9", tension: 50, min: 30 }] },         // 缺 max
    { ropes: [{ id: "R9", tension: 50, min: 30, max: "y" }] },
    { ropes: [{ id: "R9", tension: 50, min: 30, max: 80, influence: "x" }] },
    { ropes: [{ id: "R9", tension: 50, min: 30, max: 80, influence: [] }] },
    { ropes: [{ id: "R9", tension: 50, min: 30, max: 80, name: 9 }] },
  ]);
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.version, v0);
  assert.equal(d.data.ropes.length, n0);
});

test("方案预览：空体/空对象/null/targets 缺失或类型错误全部 400，不落方案、版本不变", async () => {
  const item = await readyModel();
  const v0 = (await env.call("GET", `/api/items/${item.id}`)).data.version;
  await expectRejected(`/api/items/${item.id}/plans`, [
    undefined, {}, null, [], "x",
    { targets: null },
    { targets: "x" },
    { targets: {} },
    { targets: [] },
    { targets: [null] },
    { targets: ["x"] },
    { targets: [5] },
    { targets: [{ target: 50 }] },                 // 缺 id
    { targets: [{ id: "", target: 50 }] },
    { targets: [{ id: "R1" }] },                   // 缺 target
    { targets: [{ id: "R1", target: null }] },
    { targets: [{ id: "R1", target: "" }] },
    { targets: [{ id: "R1", target: "abc" }] },
    { targets: [{ id: "R1", target: true }] },
  ]);
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.version, v0);
  assert.equal(d.data.plans.length, 0);
});

test("应用/撤销：畸形请求体与 expectedVersion 类型错误 400，版本不变；空 {} 体可用", async () => {
  const item = await readyModel();
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }],
  }, H)).data;
  const apply = `/api/items/${item.id}/plans/${plan.id}/apply`;
  const undo = `/api/items/${item.id}/plans/${plan.id}/undo`;

  for (const bad of [null, [], "x", 5, { expectedVersion: "abc" }, { expectedVersion: "" }, { expectedVersion: true }]) {
    const r = await env.call("POST", apply, bad, H);
    assert.equal(r.status, 400, JSON.stringify(bad) + " -> " + r.status);
  }
  const d0 = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d0.data.version, 2, "畸形应用请求不得推进版本");

  // 空对象 {} 体正常应用
  const a = await env.call("POST", apply, {}, H);
  assert.equal(a.status, 200);

  // 撤销畸形体 400
  for (const bad of [null, [], "x", 5]) {
    const r = await env.call("POST", undo, bad, H);
    assert.equal(r.status, 400);
  }
  // 空 {} 体正常撤销
  const u = await env.call("POST", undo, {}, H);
  assert.equal(u.status, 200);
});

test("非法 JSON 文本在所有写接口返回 400 且不改数据", async () => {
  const item = await seedItem(env.call);
  const before = await readFile(env.dbPath, "utf8");
  const paths = [
    ["/api/items", "POST"],
    [`/api/items/${item.id}`, "PATCH"],
    [`/api/items/${item.id}/logs`, "POST"],
    [`/api/items/${item.id}/action`, "POST"],
    [`/api/items/${item.id}/ropes`, "POST"],
  ];
  for (const [path, method] of paths) {
    const res = await fetch(env.base + path, {
      method,
      headers: { "Content-Type": "application/json", "X-Operator": TOKEN },
      body: "{ not json",
    });
    assert.equal(res.status, 400, `${method} ${path} -> ${res.status}`);
  }
  const after = await readFile(env.dbPath, "utf8");
  assert.equal(after, before);
});
