// 并发测试：同一方案同时应用只成功一次；串行写锁不丢更新
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupServer, seedItem, registerSample } from "./helpers.js";

import { TOKEN, OTHER_TOKEN } from "./helpers.js";
const H = { "X-Operator": TOKEN };
const H2 = { "X-Operator": OTHER_TOKEN };

test("并发应用同一方案：恰好一次真正生效，其余幂等/加锁", async () => {
  const env = await setupServer();
  try {
    const item = await seedItem(env.call);
    await registerSample(env.call, item.id);
    const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
      targets: [{ id: "R1", target: 60 }, { id: "R2", target: 50 }],
    }, H)).data;

    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () =>
        env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H)
          .then(r => r.status === 200 ? r.data.idempotent : `HTTP${r.status}`)
      )
    );
    const applied = results.filter(r => r === false).length;
    assert.equal(applied, 1, `应有且仅有一次真正应用，实际：${JSON.stringify(results)}`);
    // 其余要么 true（幂等）要么 plan_locked
    for (const r of results) assert.ok(r === true || r === false || r === "HTTP409");

    const d = await env.call("GET", `/api/items/${item.id}`);
    assert.ok(Math.abs(d.data.ropes.find(x => x.id === "R1").tension - 60) < 0.02);
    // 版本只在首次应用时前进一次
    assert.equal(d.data.version, 3);
    const appliedPlans = d.data.plans.filter(p => p.status === "applied");
    assert.equal(appliedPlans.length, 1);
  } finally {
    await env.cleanup();
  }
});

test("并发不同操作经写锁串行化，更新不丢失", async () => {
  const env = await setupServer();
  try {
    const item = await seedItem(env.call);
    await registerSample(env.call, item.id);
    // 并发：10 个备注请求 + 5 个状态请求（原流程无鉴权，与旧版一致）
    const notes = Array.from({ length: 10 }, (_, i) =>
      env.call("POST", `/api/items/${item.id}/logs`, { step: "备注", note: "n" + i }, H));
    const statuses = ["待检查", "校准中", "待复核", "已交付", "校准中"].map(s =>
      env.call("PATCH", `/api/items/${item.id}`, { status: s }));
    const all = await Promise.all([...notes, ...statuses]);
    assert.equal(all.every(r => r.status === 200 || r.status === 201), true);
    const d = await env.call("GET", `/api/items/${item.id}`);
    const noteLogs = d.data.logs.filter(l => l.note && l.note.startsWith("n"));
    assert.equal(noteLogs.length, 10);
    // 版本：登记后 v2 + 15 次变更 = 17
    assert.equal(d.data.version, 2 + 15);
  } finally {
    await env.cleanup();
  }
});
