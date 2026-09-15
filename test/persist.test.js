// 持久化测试：重启数据仍在；故障后磁盘不被半写；旧 schema 自动迁移
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupServer, seedItem, registerSample } from "./helpers.js";

import { TOKEN, OTHER_TOKEN } from "./helpers.js";
const H = { "X-Operator": TOKEN };
const H2 = { "X-Operator": OTHER_TOKEN };

test("重启后数据仍在：登记、方案、应用结果、版本全部恢复", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-persist-"));
  try {
    let env = await setupServer({ persistDir: dir });
    const item = await seedItem(env.call);
    await registerSample(env.call, item.id);
    const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
      targets: [{ id: "R1", target: 60 }, { id: "R2", target: 50 }],
    }, H)).data;
    await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
    await env.stop();

    // 同一路径再起一个实例（模拟重启）
    env = await setupServer({ persistDir: dir });
    const d = await env.call("GET", `/api/items/${item.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.data.version, 3);
    assert.equal(d.data.ropes.length, 3);
    assert.ok(Math.abs(d.data.ropes.find(r => r.id === "R1").tension - 60) < 0.02);
    assert.equal(d.data.plans[0].status, "applied");
    assert.equal(d.data.lastSafeResult.planId, plan.id);
    await env.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("注入落盘失败后：磁盘文件保持旧内容，无 .tmp 残留", async () => {
  const env = await setupServer();
  try {
    const item = await seedItem(env.call);
    await registerSample(env.call, item.id);
    const before = await readFile(env.dbPath, "utf8");
    await env.call("POST", "/api/_test/fault", { failNextWrites: 1 });
    const plan = (await env.call("POST", `/api/items/${item.id}/plans`, {
      targets: [{ id: "R1", target: 60 }],
    }, H)).data;
    await env.call("POST", `/api/items/${item.id}/plans/${plan.id}/apply`, {}, H);
    const after = await readFile(env.dbPath, "utf8");
    assert.equal(after, before, "失败写不得覆盖磁盘原文件");
    const files = await readdir(join(env.dbPath, ".."));
    assert.ok(!files.some(f => f.includes(".tmp-")), "临时文件应被清理/重命名，不留 .tmp");
  } finally {
    await env.cleanup();
  }
});

test("旧版数据文件（无 id/version/ropes）启动时自动迁移", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-migrate-"));
  let env2;
  try {
    const env = await setupServer({ persistDir: dir });
    await env.stop();
    // 覆盖成 v0 旧结构
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "db.json"), JSON.stringify({
      items: [{ code: "OLD-1", shipType: "沙船", status: "待检查", tasks: [], logs: [] }],
    }));
    env2 = await setupServer({ persistDir: dir });
    const list = await env2.call("GET", "/api/items");
    const old = list.data.find(i => i.code === "OLD-1");
    assert.ok(old, "旧记录迁移后仍可查询");
    assert.ok(old.id, "旧记录补出 id");
    assert.equal(old.version, 1);
    // 列表视图不含联调字段，通过鉴权后的详情端点验证迁移字段
    const detail = await env2.call("GET", `/api/items/${old.id}`, undefined, H);
    assert.deepEqual(detail.data.ropes, []);
    assert.equal(detail.data.lastSafeResult, null);
    // 迁移后可正常使用联调
    const reg = await env2.call("POST", `/api/items/${old.id}/ropes`, {
      ropes: [{ id: "R1", tension: 50, min: 30, max: 80 }],
    }, H);
    assert.equal(reg.status, 200);
    const d = await env2.call("GET", `/api/items/${old.id}`, undefined, H);
    assert.equal(d.data.ropes.length, 1);
  } finally {
    await env2?.cleanup();
    await rm(dir, { recursive: true, force: true });
  }
});

test("首次启动（无数据文件）写入的内置模型可直接联调，不出现 500", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-fresh-"));
  try {
    const env = await setupServer({ persistDir: dir });
    // 内置种子模型 MR-001 自带 id/version/ropes，负责人令牌 zhouning
    const d = await env.call("GET", "/api/items/MR-001", undefined, H);
    assert.equal(d.status, 200);
    assert.equal(d.data.version, 1);
    assert.deepEqual(d.data.ropes, []);
    const reg = await env.call("POST", "/api/items/MR-001/ropes", {
      ropes: [
        { id: "R1", tension: 50, min: 30, max: 80, influence: {} },
        { id: "R2", tension: 40, min: 20, max: 70, influence: { R1: 0.2 } },
      ],
    }, H);
    assert.equal(reg.status, 200, JSON.stringify(reg.data));
    const plan = await env.call("POST", "/api/items/MR-001/plans", {
      targets: [{ id: "R1", target: 60 }],
    }, H);
    assert.equal(plan.status, 201, JSON.stringify(plan.data));
    await env.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("旧版数据迁移后可完整走通联调（含空 ownerToken 不被锁死）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-migfull-"));
  try {
    const env0 = await setupServer({ persistDir: dir });
    await env0.stop();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "db.json"), JSON.stringify({
      items: [{ code: "OLD-2", shipType: "福船", status: "待检查", tasks: [], logs: [] }],
    }));
    const env = await setupServer({ persistDir: dir });
    const list = await env.call("GET", "/api/items");
    const old = list.data.find(i => i.code === "OLD-2");
    assert.ok(old.id);
    // 迁移补字段
    const d0 = await env.call("GET", `/api/items/${old.id}`, undefined, H);
    assert.equal(d0.status, 200, "无负责人旧模型任何操作员均可访问");
    const reg = await env.call("POST", `/api/items/${old.id}/ropes`, {
      ropes: [{ id: "R1", tension: 50, min: 30, max: 80 }],
    }, H);
    assert.equal(reg.status, 200);
    const plan = (await env.call("POST", `/api/items/${old.id}/plans`, {
      targets: [{ id: "R1", target: 58 }],
    }, H)).data;
    const app = await env.call("POST", `/api/items/${old.id}/plans/${plan.id}/apply`, {}, H);
    assert.equal(app.status, 200);
    const after = await env.call("GET", `/api/items/${old.id}`, undefined, H);
    assert.equal(after.data.ropes[0].tension, 58);
    await env.cleanup();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("损坏的数据文件拒绝加载而非静默重置", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rig-corrupt-"));
  try {
    const env = await setupServer({ persistDir: dir });
    await env.stop();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "db.json"), "{ this is not json");
    const env2 = await setupServer({ persistDir: dir });
    const r = await env2.call("GET", "/api/items");
    assert.equal(r.status, 500);
    assert.match(r.data.message, /损坏/);
    await env2.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
