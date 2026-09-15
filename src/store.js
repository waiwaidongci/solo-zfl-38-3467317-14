// JSON 文件存储：内存缓存（单进程权威）+ 写串行锁 + tmp/rename 原子写 + 版本迁移。
// 写失败（含测试故障注入）时回滚内存快照，保证“任一步失败整体回滚”。
import { mkdir, readFile, writeFile, rename, stat, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

let seq = 0;

export class JsonStore {
  /**
   * @param path 数据文件路径
   * @param seed 首次启动写入的种子数据
   * @param migrations [{ version, up(db) }] 按版本顺序迁移，迁移完成后落盘
   */
  constructor(path, seed, migrations = []) {
    this.path = path;
    this.seed = seed;
    this.migrations = migrations;
    this.cache = null;
    this.mtimeMs = 0;
    this.writeChain = Promise.resolve();
    // 测试故障注入：剩余失败写次数（rename 前抛错）
    this.failNextWrites = 0;
  }

  async #readFromDisk() {
    const st = await stat(this.path);
    const text = await readFile(this.path, "utf8");
    const db = JSON.parse(text);
    this.mtimeMs = st.mtimeMs;
    return db;
  }

  /**
   * 读取数据。单进程内缓存即权威：不做基于 mtime 的自动重读
   * （原子 rename 与 mtime 回赋值之间存在窗口，锁外重读会与串行写入分叉、丢更新）。
   * 重启进程自然从磁盘恢复；force 仅用于显式要求重读。
   */
  async read({ force = false } = {}) {
    if (this.cache && !force) return this.cache;
    if (!existsSync(this.path)) {
      await mkdir(dirname(this.path), { recursive: true });
      this.cache = structuredClone(this.seed);
      await this.#flush(this.cache);
      return this.cache;
    }
    let db;
    try {
      db = await this.#readFromDisk();
    } catch (e) {
      throw new Error(`数据文件损坏，拒绝加载：${e.message}`);
    }
    const targetVersion = this.migrations.at(-1)?.version ?? 0;
    if ((db.schemaVersion ?? 0) < targetVersion) {
      db = this.#migrate(db);
      await this.#flush(db);
    }
    this.cache = db;
    return db;
  }

  #migrate(db) {
    let v = db.schemaVersion ?? 0;
    for (const m of this.migrations) {
      if (m.version > v) {
        db = m.up(db) ?? db;
        db.schemaVersion = m.version;
        v = m.version;
      }
    }
    this.mtimeMs = 0;
    return db;
  }

  async #flush(db) {
    const tmp = join(dirname(this.path), `.${this.path.split("/").pop()}.tmp-${process.pid}-${++seq}`);
    const payload = JSON.stringify(db, null, 2);
    await writeFile(tmp, payload, "utf8");
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      await rm(tmp, { force: true });
      throw new Error("injected_write_failure");
    }
    await rename(tmp, this.path);
    this.mtimeMs = (await stat(this.path)).mtimeMs;
  }

  /**
   * 在写锁内执行修改：先快照，mutator 改内存对象，随后原子落盘；
   * 落盘失败则恢复快照并抛出，调用方据此向客户端返回错误且原记录不动。
   */
  async mutate(mutator) {
    const release = await this.#acquire();
    const db = await this.read();
    const snapshot = structuredClone(db);
    try {
      const result = await mutator(db);
      await this.#flush(db);
      release();
      return result;
    } catch (e) {
      this.cache = snapshot;
      this.mtimeMs = 0;
      release();
      throw e;
    }
  }

  #acquire() {
    let unlock;
    const prev = this.writeChain;
    this.writeChain = new Promise(resolve => {
      unlock = resolve;
    });
    return prev.then(() => unlock);
  }
}
