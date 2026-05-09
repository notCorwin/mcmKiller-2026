---
name: numerical-optimization
description: 数值优化问题的 Python 求解模式（线性规划、非线性规划、组合优化）
triggers:
  - "优化"
  - "optimization"
  - "线性规划"
  - "非线性规划"
  - "整数规划"
  - "组合优化"
  - "LP"
  - "NLP"
---

# 数值优化实现模式

## 线性规划 (LP)

```python
from scipy.optimize import linprog

# min c^T x  subject to  A_ub x <= b_ub, A_eq x == b_eq, bounds
res = linprog(c, A_ub=A_ub, b_ub=b_ub, A_eq=A_eq, b_eq=b_eq,
              bounds=[(0, None) for _ in range(n)], method="highs")
# res.x → 最优解, res.fun → 最优值
```

## 非线性规划 (NLP) — SciPy

```python
from scipy.optimize import minimize

def objective(x):
    return ...  # 标量

def constraint_eq(x):
    return ...  # == 0

def constraint_ineq(x):
    return ...  # >= 0

cons = [{"type": "eq", "fun": constraint_eq},
        {"type": "ineq", "fun": constraint_ineq}]
bounds = [(0, None) for _ in range(n)]
res = minimize(objective, x0, method="SLSQP", bounds=bounds, constraints=cons)
```

## 凸优化 — CVXPY

```python
import cvxpy as cp

x = cp.Variable(n)
objective = cp.Minimize(cp.sum_squares(A @ x - b))
constraints = [x >= 0, cp.sum(x) == 1]
prob = cp.Problem(objective, constraints)
prob.solve()
# x.value → 最优解, prob.value → 最优值
```

## 组合优化 — 遗传算法

```python
from scipy.optimize import differential_evolution

# 适用于非凸、不连续、高维且梯度不可用的目标函数
res = differential_evolution(objective, bounds=[(0, 1) for _ in range(n)],
                             strategy="best1bin", maxiter=1000, popsize=30,
                             seed=42)
```

## 整数规划 — pulp

```python
import pulp

prob = pulp.LpProblem("name", pulp.LpMinimize)
x = [pulp.LpVariable(f"x{i}", cat="Binary") for i in range(n)]
prob += pulp.lpSum(c[i] * x[i] for i in range(n))
for constr in constraints:
    prob += pulp.lpSum(...) <= ...
prob.solve(pulp.PULP_CBC_CMD(msg=False))
result = [pulp.value(x[i]) for i in range(n)]
```

## 注意事项

- `scipy.optimize.minimize` 的 SLSQP/trust-constr 适用于中小规模问题
- 大规模 (>10000 变量) 线性规划优先用 `method="highs"`
- 非凸问题务必尝试多个随机初始点
- `differential_evolution` 全局搜索强但不保证最优，适合方案验证
