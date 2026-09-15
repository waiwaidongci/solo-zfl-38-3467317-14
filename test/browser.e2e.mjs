// 真实浏览器 E2E：puppeteer + 下载的 Chromium。
// 走通三条流程：①成功联调并撤销 ②无解被拒绝、原记录不动 ③过期版本冲突。
// 用法：node test/browser.e2e.mjs
import puppeteer from "puppeteer";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const PORT = 40000 + Math.floor(Math.random() * 8000);

// 无 root 环境下从本地解包的 Debian arm64 Chromium 前缀运行（CHROME_BIN 可覆盖）
const localPrefix = join(homedir(), "chromium-arm", "root");
const localChrome = join(localPrefix, "usr/lib/chromium/chromium");
if (!process.env.CHROME_BIN && existsSync(localChrome)) {
  process.env.CHROME_BIN = localChrome;
  const libDirs = [
    "usr/lib/aarch64-linux-gnu",
    "usr/lib/aarch64-linux-gnu/nss",
    "usr/lib/aarch64-linux-gnu/pulseaudio",
    "lib/aarch64-linux-gnu",
    "usr/lib/chromium",
  ].map(d => join(localPrefix, d)).join(":");
  process.env.LD_LIBRARY_PATH = libDirs + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : "");
}

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log((cond ? "PASS" : "FAIL") + " - " + name + (detail ? " | " + detail : ""));
  if (!cond) process.exitCode = 1;
}

const dataDir = await mkdtemp(join(tmpdir(), "rig-e2e-"));
const dbPath = join(dataDir, "db.json");
const serverProc = spawn(process.execPath, [join(root, "server.js")], {
  env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath, ALLOW_FAULT: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  detached: true, // 独立进程组，测试退出时整组回收，避免端口上的孤儿进程
});
const serverLogs = [];
serverProc.stdout.on("data", d => serverLogs.push(String(d)));
serverProc.stderr.on("data", d => serverLogs.push(String(d)));
let serverExited = null;
serverProc.on("exit", code => { serverExited = code; });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("server start timeout\n" + serverLogs.join(""))), 15000);
  const tick = async () => {
    if (serverExited !== null) return rej(new Error("server exited with " + serverExited + "\n" + serverLogs.join("")));
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/items`);
      if (r.ok) { clearTimeout(t); res(); } else setTimeout(tick, 200);
    } catch { setTimeout(tick, 200); }
  };
  tick();
});

const browser = await puppeteer.launch({
  headless: "new",
  executablePath: process.env.CHROME_BIN || undefined,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
    "--disable-gpu", "--disable-software-rasterizer", "--no-first-run", "--disable-extensions"],
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e) + "\n" + (e.stack || "")));
  page.on("console", m => {
    if (m.type() !== "error") return;
    const t = m.text();
    // 资源状态噪声：favicon 404、被预期拒绝的 422 预览与 409 冲突都不算前端错误
    if (/Failed to load resource|status of (404|409|422|403)/.test(t)) return;
    errors.push(t);
  });
  page.on("requestfailed", r => errors.push("REQUEST_FAILED " + r.url() + " :: " + r.failure()?.errorText));
  page.on("dialog", d => d.dismiss().catch(() => {}));

  // 准备一个测试模型（API）
  const token = "e2e-user";
  const created = await (await fetch(`http://127.0.0.1:${PORT}/api/items`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "E2E-1", shipType: "福船", owner: "E2E测试员", ownerToken: token }),
  })).json();
  const itemKey = encodeURIComponent(created.id);

  await page.goto(`http://127.0.0.1:${PORT}/`);
  await page.waitForSelector("#cards");
  await page.type("#operator", "");
  await page.$eval("#operator", el => { el.value = "e2e-user"; el.dispatchEvent(new Event("input")); });
  // 切到联调页签
  await page.click("#tabAdjust");
  await page.waitForSelector("#adjItem option");
  await page.select("#adjItem", created.id);
  await new Promise(r => setTimeout(r, 300));

  async function registerRope(id, tension, min, max, influence) {
    await page.$eval("#rId", (el, v) => el.value = v, id);
    await page.$eval("#rName", el => el.value = "");
    await page.$eval("#rTension", (el, v) => el.value = v, String(tension));
    await page.$eval("#rMin", (el, v) => el.value = v, String(min));
    await page.$eval("#rMax", (el, v) => el.value = v, String(max));
    await page.$eval("#rInfluence", (el, v) => el.value = v, JSON.stringify(influence));
    await page.click("#btnRegister");
    await new Promise(r => setTimeout(r, 250));
  }

  /* ---------- 场景一：成功 ---------- */
  // 影响系数引用的索必须先存在：先无引用登记，再补系数
  await registerRope("R1", 50, 30, 80, {});
  await registerRope("R2", 40, 20, 70, { R1: 0.2 });
  await registerRope("R1", 50, 30, 80, { R2: 0.3 });

  let rows = await page.$$eval("#ropeTable tr", trs => trs.length);
  check("成功-登记两根索", rows === 3, "表格行数=" + rows);

  // 勾选两索目标
  await page.$eval('[data-value="R1"]', el => el.value = "60");
  await page.$eval('[data-value="R2"]', el => el.value = "50");
  await page.click('[data-target="R1"]');
  await page.click('[data-target="R2"]');
  await page.click("#btnPreview");
  await page.waitForSelector("#preview .alert.ok", { timeout: 5000 });
  const okText = await page.$eval("#preview .alert.ok", el => el.textContent);
  check("成功-预览收敛且终值在区间", /收敛/.test(okText), okText);
  const finals = await page.$$eval("#preview table:nth-of-type(2) td", tds => tds.map(td => td.textContent));
  check("成功-预测终值 R1=60 R2=50", finals.join("|").includes("60") && finals.join("|").includes("50"));

  const applyBtnEnabled = await page.$eval("#btnApply", el => !el.disabled);
  check("成功-应用按钮可用", applyBtnEnabled);
  await page.click("#btnApply");
  await page.waitForSelector("#applyResult .alert.ok", { timeout: 5000 });
  const applyText = await page.$eval("#applyResult .alert.ok", el => el.textContent);
  check("成功-原子应用成功", /原子应用成功/.test(applyText), applyText);

  const after = await (await fetch(`http://127.0.0.1:${PORT}/api/items/${itemKey}`)).json();
  check("成功-后端张力已更新", Math.abs(after.ropes.find(r => r.id === "R1").tension - 60) < 0.02
    && Math.abs(after.ropes.find(r => r.id === "R2").tension - 50) < 0.02);
  check("成功-记录可撤销的上次安全结果", after.lastSafeResult && after.lastSafeResult.undoable === true);

  // 撤销
  await new Promise(r => setTimeout(r, 300));
  const undoEnabled = await page.$eval("#btnUndo", el => !el.disabled);
  check("成功-撤销按钮可用", undoEnabled);
  await page.click("#btnUndo");
  await new Promise(r => setTimeout(r, 400));
  const undone = await (await fetch(`http://127.0.0.1:${PORT}/api/items/${itemKey}`)).json();
  check("成功-撤销后张力恢复", undone.ropes.find(r => r.id === "R1").tension === 50
    && undone.ropes.find(r => r.id === "R2").tension === 40);
  check("成功-撤销后 lastSafeResult 不可再撤销", undone.lastSafeResult.undoable === false);

  /* ---------- 场景二：无解 ---------- */
  const noSol = await (await fetch(`http://127.0.0.1:${PORT}/api/items`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "E2E-2", shipType: "鸟船", owner: "E2E测试员", ownerToken: token }),
  })).json();
  const reg = async (id, body) => fetch(`http://127.0.0.1:${PORT}/api/items/${encodeURIComponent(noSol.id)}/ropes`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Operator": token }, body: JSON.stringify(body),
  });
  const regBoth = await reg("all", { ropes: [
    { id: "R1", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
    { id: "R2", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
  ] });
  if (!regBoth.ok) throw new Error("no-solution setup failed: " + regBoth.status);

  await page.click("#reload"); // API 新建的模型需刷新下拉框
  await new Promise(r => setTimeout(r, 300));
  await page.select("#adjItem", noSol.id);
  await new Promise(r => setTimeout(r, 300));
  await page.$eval('[data-value="R1"]', el => el.value = "60");
  await page.$eval('[data-value="R2"]', el => el.value = "50");
  await page.click('[data-target="R1"]');
  await page.click('[data-target="R2"]');
  await page.click("#btnPreview");
  try {
    await page.waitForFunction(() => document.querySelector("#preview").textContent.includes("无解"), { timeout: 5000 });
  } catch {
    const txt = await page.$eval("#preview", el => el.textContent.slice(0, 300)).catch(() => "<no preview>");
    throw new Error("无解文案未出现，实际预览：" + txt);
  }
  const blockedText = await page.$eval("#preview", el => el.textContent);
  check("无解-页面明确显示阻塞", /无解/.test(blockedText));
  const applyDisabled = await page.$eval("#btnApply", el => el.disabled);
  check("无解-应用按钮保持禁用", applyDisabled);
  const noSolDetail = await (await fetch(`http://127.0.0.1:${PORT}/api/items/${encodeURIComponent(noSol.id)}`)).json();
  check("无解-方案未落库、原记录不动", noSolDetail.plans.length === 0 && noSolDetail.version === 2);

  /* ---------- 场景三：过期版本冲突 ---------- */
  // 新模型：预览后，通过 API 改登记使版本前进，再点页面上已生成方案的应用
  const conf = await (await fetch(`http://127.0.0.1:${PORT}/api/items`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: "E2E-3", shipType: "广船", owner: "E2E测试员", ownerToken: token }),
  })).json();
  const ckey = encodeURIComponent(conf.id);
  const setupR = await fetch(`http://127.0.0.1:${PORT}/api/items/${ckey}/ropes`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Operator": token },
    body: JSON.stringify({ ropes: [
      { id: "R1", tension: 50, min: 30, max: 80, influence: { R2: 0.3 } },
      { id: "R2", tension: 40, min: 20, max: 70, influence: { R1: 0.2 } },
    ] }),
  });
  if (!setupR.ok) throw new Error("conf setup " + await setupR.text());
  await page.click("#reload");
  await new Promise(r => setTimeout(r, 300));
  await page.select("#adjItem", conf.id);
  await new Promise(r => setTimeout(r, 300));
  await page.$eval('[data-value="R1"]', el => el.value = "60");
  await page.click('[data-target="R1"]');
  await page.click("#btnPreview");
  await page.waitForSelector("#preview .alert.ok", { timeout: 5000 });
  // 外部并发改动：版本前进使草案过期
  await fetch(`http://127.0.0.1:${PORT}/api/items/${ckey}/ropes`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Operator": token },
    body: JSON.stringify({ ropes: [{ id: "R1", tension: 51, min: 30, max: 80, influence: { R2: 0.3 } }] }),
  });
  await page.click("#btnApply");
  await page.waitForFunction(() => {
    const el = document.querySelector("#applyResult .alert.block");
    return el && /冲突/.test(el.textContent);
  }, { timeout: 5000 });
  const conflictText = await page.$eval("#applyResult .alert.block", el => el.textContent);
  check("冲突-过期版本应用被拒绝并提示", /冲突|过期版本/.test(conflictText), conflictText);
  const confDetail = await (await fetch(`http://127.0.0.1:${PORT}/api/items/${ckey}`)).json();
  check("冲突-张力未被错误应用", confDetail.ropes.find(r => r.id === "R1").tension === 51);
  check("冲突-方案仍为 draft 未生效", confDetail.plans.every(p => p.status !== "applied"));

  /* ---------- 越权场景 ---------- */
  const forbid = await fetch(`http://127.0.0.1:${PORT}/api/items/${ckey}/ropes`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Operator": "intruder" },
    body: JSON.stringify({ ropes: [{ id: "R1", tension: 52, min: 30, max: 80 }] }),
  });
  check("越权-他人操作员被 403 拒绝", forbid.status === 403);

  check("浏览器无 JS 错误", errors.length === 0, errors.slice(0, 3).join(" ;; "));

  await browser.close();
} catch (e) {
  check("E2E 执行异常: " + e.message, false, e.stack?.split("\n").slice(0, 4).join(" / "));
  await browser.close();
} finally {
  serverObj(serverProc);
  await rm(dataDir, { recursive: true, force: true });
}
function serverObj(p) {
  try { process.kill(-p.pid, "SIGTERM"); } catch { try { p.kill("SIGTERM"); } catch {} }
}

const failed = results.filter(r => !r.ok).length;
console.log(`\nE2E: ${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
