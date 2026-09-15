import { test } from "node:test";
import assert from "node:assert/strict";
import { planAdjustment, solveLinear, validateRopes } from "../src/adjustment.js";
import { SAMPLE_ROPES } from "./helpers.js";

test("validateRopes：正常登记返回索序与方阵", () => {
  const { ids, A } = validateRopes(SAMPLE_ROPES);
  assert.deepEqual(ids, ["R1", "R2", "R3"]);
  assert.equal(A[0][0], 1);
  assert.equal(A[0][1], 0.3);
  assert.equal(A[2][1], 0.15);
});

test("数据异常：非数值张力 / 非法区间 / 重复 id / 未知引用 全部拒绝", () => {
  assert.throws(() => validateRopes([{ id: "X", tension: NaN, min: 0, max: 10 }]), /有效数值/);
  assert.throws(() => validateRopes([{ id: "X", tension: 5, min: 10, max: 10 }]), /安全区间非法/);
  assert.throws(() => validateRopes([{ id: "X", tension: 5, min: 0, max: 10 }, { id: "X", tension: 1, min: 0, max: 10 }]), /重复/);
  assert.throws(() => validateRopes([{ id: "X", tension: 5, min: 0, max: 10, influence: { Y: 1 } }]), /未知索/);
  assert.throws(() => validateRopes([{ id: "X", tension: 5, min: 0, max: 10, influence: { X: "abc" } }]), /影响系数/);
});

test("solveLinear：可逆方程组正确求解", () => {
  const r = solveLinear([[2, 1], [1, -1]], [3, 0]);
  assert.ok(!r.singular);
  assert.ok(Math.abs(r.x[0] - 1) < 1e-9);
  assert.ok(Math.abs(r.x[1] - 1) < 1e-9);
});

test("solveLinear：奇异且矛盾判定为无解", () => {
  const r = solveLinear([[1, 1], [1, 1]], [10, 20]);
  assert.equal(r.singular, true);
  assert.equal(r.inconsistent, true);
});

test("联动两索目标：精确解、逐步量、终值与收敛均正确", () => {
  // t=(50,40)，A=[[1,.2],[.3,1]]；目标(60,50)
  const ropes = [SAMPLE_ROPES[0], SAMPLE_ROPES[1]];
  const p = planAdjustment(ropes, [{ id: "R1", target: 60 }, { id: "R2", target: 50 }]);
  assert.equal(p.blockers.length, 0, JSON.stringify(p.blockers));
  assert.equal(p.converged, true);
  assert.ok(p.residual <= 0.01);
  assert.ok(Math.abs(p.finalTensions.R1 - 60) < 0.02);
  assert.ok(Math.abs(p.finalTensions.R2 - 50) < 0.02);
  // 总调节量与精确解一致
  assert.ok(Math.abs(p.adjustments.R1 - p.exactAdjustments.R1) < 0.05);
  assert.ok(Math.abs(p.adjustments.R2 - p.exactAdjustments.R2) < 0.05);
  // 逐步记录每一步都含全量张力
  assert.ok(p.steps.length >= 2);
  for (const s of p.steps) {
    assert.ok("R1" in s.tensions && "R2" in s.tensions);
    assert.equal(typeof s.adjust, "number");
  }
});

test("目标越界 -> target_out_of_range 阻塞", () => {
  const p = planAdjustment(SAMPLE_ROPES, [{ id: "R1", target: 999 }]);
  assert.ok(p.blockers.some(b => b.code === "target_out_of_range"));
  assert.equal(p.converged, false);
});

test("联动导致非目标索预测终值越界 -> final_out_of_range", () => {
  const ropes = [
    { id: "A", tension: 50, min: 40, max: 60, influence: {} },
    { id: "C", tension: 50, min: 40, max: 60, influence: { A: 5 } },
  ];
  const p = planAdjustment(ropes, [{ id: "A", target: 55 }]);
  // A 调 +5 使 C 被推高 25 → 终值 75，越界
  assert.ok(p.blockers.some(b => b.code === "final_out_of_range"), JSON.stringify(p.blockers));
});

test("奇异矛盾矩阵 -> no_solution", () => {
  const ropes = [
    { id: "R1", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
    { id: "R2", tension: 50, min: 0, max: 200, influence: { R1: 1, R2: 1 } },
  ];
  const p = planAdjustment(ropes, [{ id: "R1", target: 60 }, { id: "R2", target: 50 }]);
  assert.ok(p.blockers.some(b => b.code === "no_solution"), JSON.stringify(p.blockers));
});

test("不收敛：强耦合发散矩阵给出 not_converged/越界阻塞", () => {
  const ropes = [
    { id: "A", tension: 50, min: -10000, max: 10000, influence: { B: 2 } },
    { id: "B", tension: 50, min: -10000, max: 10000, influence: { A: 2 } },
  ];
  const p = planAdjustment(ropes, [{ id: "A", target: 60 }, { id: "B", target: 60 }], { maxSweeps: 20 });
  assert.ok(p.blockers.length > 0);
  assert.equal(p.converged, false);
});

test("当前张力越界产生风险但不阻塞拉回区间的方案", () => {
  const ropes = [
    { id: "A", tension: 90, min: 40, max: 80, influence: {} },
  ];
  const p = planAdjustment(ropes, [{ id: "A", target: 60 }]);
  assert.equal(p.blockers.length, 0, JSON.stringify(p.blockers));
  assert.ok(p.risks.some(r => r.code === "current_out_of_range"));
});

test("未知目标索 / 空目标 -> 阻塞或异常返回", () => {
  const p = planAdjustment(SAMPLE_ROPES, [{ id: "ZZ", target: 50 }]);
  assert.ok(p.blockers.some(b => b.code === "unknown_rope"));
  const q = planAdjustment(SAMPLE_ROPES, []);
  assert.ok(q.blockers.length > 0);
});
