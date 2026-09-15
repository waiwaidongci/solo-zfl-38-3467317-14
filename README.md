# 古船模型帆索校准（含多索联调）

运行：

```bash
npm start          # http://localhost:3038
npm test           # 单元/接口/并发/回滚/持久化测试（31 项）
npm run test:e2e   # 真实 Chromium 端到端：成功 / 无解 / 冲突
```

数据保存在 `data/model-rigging-calibration.json`（原子写：临时文件 + rename，重启后数据仍在，旧版数据文件启动时自动迁移）。

## 多索联调

页面“多索联调”页签按四步操作；原“建档 / 帆索任务”流程保持不变。

1. **登记索**：每根索记录当前张力、安全区间 [min, max]、影响系数（调本索 1N 引起其他索的张力变化，对角缺省为 1）。
2. **选目标并预览**：勾选多根索、填目标值后“方案预览”（不改动数据）。
   - 输出逐步调节量（逐根 Gauss-Seidel 扫掠，每步含全索张力）、总调节量、预测终值、残差与是否收敛；
   - 风险（当前已越界、终值贴边界）以黄色提示，阻塞（目标越界、预测/轨迹越界、无解、奇异、不收敛、数据异常）以红色列出并 **422 拒绝，原记录不动**。
3. **按版本原子应用**：方案带 `baseVersion`。
   - 落盘失败整体回滚（内存快照恢复 + 原文件不被半写覆盖）；
   - 重复提交同一方案只生效一次（返回 `idempotent`）；
   - 并发应用同一方案只成功一次（进程内方案锁 + 串行写锁）；
   - 过期版本（登记被改过）与 `expectedVersion` 不匹配返回 409，拒绝应用。
4. **撤销**：只可撤销“上次安全结果”，恢复应用前张力；撤销后的方案不能再次应用。

### 鉴权与输入约束

- 联调写接口（索登记 / 预览 / 应用 / 撤销）与详情读取（模型详情、方案列表）要求 `X-Operator` 请求头（百分号编码）；模型有负责人时，非负责人返回 403。建档/列表等原有接口保持无鉴权，且**列表视图不返回**索集合、方案、上次安全结果、令牌。
- **所有写接口统一请求体校验**：空请求体、`null`、数组、标量、空对象（缺少必填字段）、字段缺失、**未知字段**或类型错误，一律返回 400 `bad_request` 并给出中文字段名提示；校验全部在落库前完成，被拒绝时原数据、版本号与磁盘文件均不变。
  - 建档采用字段白名单（`code/shipType/scale/mastCount/riggingMaterial/owner/ownerToken/dueDate/status`）：`code` 必须是非空字符串；`scale/riggingMaterial/shipType/owner/ownerToken` 必须是字符串；`dueDate` 必须是真实的 `YYYY-MM-DD`；`mastCount` 必须是数值（空串视为未填）；`status` 必须是合法阶段；受保护字段（`id/version/ropes/plans/lastSafeResult/tasks/logs`）返回 400 `reserved_field`。
  - PATCH 仅允许 `status`；备注仅允许 `note`（非空字符串）/`step`；帆索任务仅允许 `position`/`tension`（均为非空字符串）/`note`。
  - 索登记仅允许 `id/name/tension/min/max/influence`：**`id` 必须是非空字符串**（数字、布尔、对象、数组不再被隐式转字符串），`name` 必须是字符串，`tension/min/max` 与每个影响系数必须是有限数值，`influence` 必须是字符串键→数值的对象。
  - 方案预览仅允许 `targets`（非空对象数组），每项 `id` 必须是非空字符串、`target` 必须是有限数值。
  - 应用允许空 `{}` 体（幂等），但 `expectedVersion` 必须是数值；撤销体必须是对象且不含未知字段。
  - 非法 JSON 文本统一 400。
- 同一安全结果只能撤销一次：重复撤销返回 409 且版本不推进。
- 首次启动（无数据文件）写入的内置模型与旧版数据迁移后的模型，均自带 `id/version/ropes` 等字段，可直接联调。

### 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/items/:id/ropes` | 登记/更新索（upsert，校验合并后的完整集合） |
| POST | `/api/items/:id/plans` | 方案预览；阻塞时 422 且 body 含 `preview`，不落库 |
| GET | `/api/items/:id/plans` | 方案列表 |
| POST | `/api/items/:id/plans/:pid/apply` | 原子应用（幂等/并发唯一/版本校验/应用前复算） |
| POST | `/api/items/:id/plans/:pid/undo` | 撤销上次安全结果 |

原接口 `/api/items`（GET/POST/PATCH）、`/logs`、`/action`、`/stats` 行为不变。
