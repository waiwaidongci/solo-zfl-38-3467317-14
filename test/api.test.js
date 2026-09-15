// 接口测试：登记、预览、原子应用、幂等、版本冲突、越权、撤销、回滚、原流程兼容
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { setupServer, seedItem, registerSample, SAMPLE_ROPES } from "./helpers.js";

let env;
before(async () => { env = await setupServer(); });
after(async () => { await env.cleanup(); });

import { TOKEN, OTHER_TOKEN } from "./helpers.js";
const H = { "X-Operator": TOKEN };
const H2 = { "X-Operator": OTHER_TOKEN };

test("原流程仍可用：建档/帆索任务/状态/备注/统计", async () => {
  const item = await seedItem(env.call);
  assert.equal(item.status, undefined); // 种子新建设未指定状态

  const a = await env.call("POST", `/api/items/${item.id}/action`, { position: "前桅支索", tension: "偏松", note: "缩短1mm" });
  assert.equal(a.status, 201);
  assert.equal(a.data.status, "校准中");
  assert.equal(a.data.tasks.length, 1);

  const p = await env.call("PATCH", `/api/items/${item.id}`, { status: "待复核" });
  assert.equal(p.status, 200);
  assert.equal(p.data.status, "待复核");

  const l = await env.call("POST", `/api/items/${item.id}/logs`, { step: "备注", note: "复核通过" });
  assert.equal(l.status, 201);

  const list = await env.call("GET", "/api/items");
  assert.ok(list.data.find(i => i.id === item.id));
  const stats = await env.call("GET", "/api/stats");
  assert.equal(stats.status, 200);
  assert.ok("待复核" in stats.data);
});

test("登记：无操作员头 403；他人模型越权 403", async () => {
  const mine = await seedItem(env.call, "周宁");
  const other = await seedItem(env.call, "李四", { ownerToken: OTHER_TOKEN });
  const noAuth = await env.call("POST", `/api/items/${mine.id}/ropes`, { ropes: SAMPLE_ROPES });
  assert.equal(noAuth.status, 403);
  assert.equal(noAuth.data.error, "forbidden");
  const cross = await env.call("POST", `/api/items/${other.id}/ropes`, { ropes: SAMPLE_ROPES }, H);
  assert.equal(cross.status, 403);
});

test("登记：数据异常拒绝（422）且原记录不动", async () => {
  const item = await seedItem(env.call);
  const bad = await env.call("POST", `/api/items/${item.id}/ropes`, {
    ropes: [{ id: "R1", tension: "abc", min: 30, max: 80 }],
  }, H);
  assert.equal(bad.status, 422);
  assert.equal(bad.data.error, "data_anomaly");
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.deepEqual(d.data.ropes, []);
  assert.equal(d.data.version, 1);
});

test("登记 upsert：同 id 更新并升版本", async () => {
  const item = await seedItem(env.call);
  const rope0 = { id: "R1", tension: 50, min: 30, max: 80, influence: {} };
  await registerSample(env.call, item.id, [rope0]);
  let d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.version, 2);
  assert.equal(d.data.ropes[0].tension, 50);
  await env.call("POST", `/api/items/${item.id}/ropes`, {
    ropes: [{ ...rope0, tension: 52 }],
  }, H);
  d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.ropes.length, 1);
  assert.equal(d.data.ropes[0].tension, 52);
  assert.equal(d.data.version, 3);
});

test("预览：可执行方案 201，重复预览幂等返回同一草案", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const targets = [{ id: "R1", target: 60 }, { id: "R2", target: 50 }];
  const p1 = await env.call("POST", `/api/items/${item.id}/plans`, { targets }, H);
  assert.equal(p1.status, 201);
  assert.equal(p1.data.converged, true);
  assert.equal(p1.data.baseVersion, 2);
  assert.ok(p1.data.steps.length >= 2);
  const p2 = await env.call("POST", `/api/items/${item.id}/plans`, { targets }, H);
  assert.equal(p2.status, 200);
  assert.equal(p2.data.id, p1.data.id);
});

test("预览：无解 422 且不落方案、不动版本", async () => {
  const item = await seedItem(env.call);
  const ropes = [
    { id: "R1", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
    { id: "R2", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
  ];
  await registerSample(env.call, item.id, ropes);
  const blocked = await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }, { id: "R2", target: 50 }],
  }, H);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.data.error, "plan_blocked");
  assert.ok(blocked.data.preview.blockers.some(b => b.code === "no_solution"));
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.plans.length, 0);
  assert.equal(d.data.version, 2);
});

test("预览：目标越界同样拒绝、原记录不动", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const r = await env.call("POST", `/api/items/${item.id}/plans`, { targets: [{ id: "R1", target: 999 }] }, H);
  assert.equal(r.status, 422);
  assert.ok(r.data.preview.blockers.some(b => b.code === "target_out_of_range"));
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.plans.length, 0);
});

test("应用成功：张力变为终值、版本 +1、记录 lastSafeResult", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }, { id: "R2", target: 50 }],
  }, H)).data;
  const app = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  assert.equal(app.status, 200);
  assert.equal(app.data.idempotent, false);
  assert.equal(app.data.version, 3);
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.ok(Math.abs(d.data.ropes.find(r => r.id === "R1").tension - 60) < 0.02);
  assert.ok(Math.abs(d.data.ropes.find(r => r.id === "R2").tension - 50) < 0.02);
  assert.equal(d.data.lastSafeResult.planId, plan.id);
  assert.equal(d.data.lastSafeResult.undoable, true);
  assert.equal(d.data.version, 3);
});

test("重复提交同一方案只生效一次（幂等）", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 58 }],
  }, H)).data;
  const a1 = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  const v1 = a1.data.version;
  const a2 = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  assert.equal(a2.status, 200);
  assert.equal(a2.data.idempotent, true);
  assert.equal(a2.data.version, v1);
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.ropes.find(r => r.id === "R1").tension, 58);
});

test("过期版本：应用期间索登记发生变化 -> 409 version_conflict", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }],
  }, H)).data;
  // 登记更新 -> 版本前进，草案过期
  await env.call("POST", `/api/items/${item.id}/ropes`, { ropes: [{ ...SAMPLE_ROPES[0], tension: 55 }] }, H);
  const app = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  assert.equal(app.status, 409);
  assert.equal(app.data.error, "version_conflict");
  assert.equal(app.data.currentVersion, 3);
  assert.equal(app.data.baseVersion, 2);
  // 原记录未被改动（保持 55）
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.ropes.find(r => r.id === "R1").tension, 55);
});

test("expectedVersion 乐观锁不匹配同样 409", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }],
  }, H)).data;
  const app = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, { expectedVersion: 999 }, H);
  assert.equal(app.status, 409);
});

test("撤销上次安全结果：张力恢复、方案标记 undone、不能再次应用", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }, { id: "R2", target: 50 }],
  }, H)).data;
  await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  const undo = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/undo`, {}, H);
  assert.equal(undo.status, 200);
  const d = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d.data.ropes.find(r => r.id === "R1").tension, 50);
  assert.equal(d.data.ropes.find(r => r.id === "R2").tension, 40);
  assert.equal(d.data.lastSafeResult.undoable, false);
  const reapp = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  assert.equal(reapp.status, 409);
  assert.equal(reapp.data.error, "plan_undone");
});

test("回滚：落盘注入失败时应用报错且内存/磁盘原记录不动", async () => {
  const item = await seedItem(env.call);
  await registerSample(env.call, item.id);
  const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
    targets: [{ id: "R1", target: 60 }],
  }, H)).data;
  const fault = await env.call("POST", "/api/_test/fault", { failNextWrites: 1 });
  assert.equal(fault.status, 200);
  const app = await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
  assert.equal(app.status >= 500, true);
  // 缓存已回滚：后续读取仍是旧值
  const d1 = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d1.data.ropes.find(r => r.id === "R1").tension, 50);
  assert.equal(d1.data.version, 2);
  // 磁盘内容也未被半写覆盖
  const d2 = await env.call("GET", `/api/items/${item.id}`);
  assert.equal(d2.data.ropes.find(r => r.id === "R1").tension, 50);
});

test("非法 JSON 请求体返回 400", async () => {
  const res = await fetch(env.base + "/api/items", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ not json",
  });
  assert.equal(res.status, 400);
});
