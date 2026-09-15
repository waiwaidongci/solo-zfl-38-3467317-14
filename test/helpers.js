// 测试辅助：临时库 + 起停服务 + 简化 fetch 封装
process.env.ALLOW_FAULT = "1";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { JsonStore } from "../src/store.js";
import { seed, migrations } from "../src/app.js";

export async function setupServer({ clock = [], persistDir } = {}) {
  const dir = persistDir || await mkdtemp(join(tmpdir(), "rig-test-"));
  const dbPath = join(dir, "db.json");
  const store = new JsonStore(dbPath, seed, migrations);
  let t = 0;
  const now = clock.length ? () => new Date(clock[Math.min(t++, clock.length - 1)]) : () => new Date(`2026-09-15T10:0${t++ % 10}:00Z`);
  const server = createApp(store, { now });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      // 默认以种子负责人令牌调用；需要测无身份时显式传 { "X-Operator": "" }
      headers: { "Content-Type": "application/json", "X-Operator": TOKEN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    return { status: res.status, data, headers: res.headers };
  }
  async function stop() {
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
  }
  async function cleanup() {
    await stop();
    if (!persistDir) await rm(dir, { recursive: true, force: true });
  }
  return { dir, dbPath, store, server, base, call, stop, cleanup };
}

export const SAMPLE_ROPES = [
  { id: "R1", name: "前桅侧支索", tension: 50, min: 30, max: 80, influence: { R2: 0.3 } },
  { id: "R2", name: "后桅升帆索", tension: 40, min: 20, max: 70, influence: { R1: 0.2 } },
  { id: "R3", name: "主桅稳索", tension: 45, min: 25, max: 75, influence: { R1: -0.1, R2: 0.15 } },
];

export async function seedItem(call, owner = "周宁", extra = {}) {
  const r = await call("POST", "/api/items", {
    code: "M-" + Math.random().toString(36).slice(2, 8),
    shipType: "福船",
    owner,
    ownerToken: TOKEN,
    ...extra,
  });
  if (r.status !== 201) throw new Error("seedItem failed: " + JSON.stringify(r.data));
  return r.data;
}

export const TOKEN = "zhouning";
export const OTHER_TOKEN = "lisi";

export async function registerSample(call, key, ropes = SAMPLE_ROPES) {
  const r = await call("POST", `/api/items/${encodeURIComponent(key)}/ropes`, { ropes }, { "X-Operator": TOKEN });
  if (r.status !== 200) throw new Error("registerSample failed: " + JSON.stringify(r.data));
  return r.data;
}
