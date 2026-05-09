---
name: monte-carlo
description: 蒙特卡洛方法与随机模拟的高性能实现模式
triggers:
  - "蒙特卡洛"
  - "Monte Carlo"
  - "随机模拟"
  - "MonteCarlo"
  - "随机采样"
---

# 蒙特卡洛模拟加速模式

## 核心原则

在 Python 中做大规模蒙特卡洛模拟，性能瓶颈在于逐样本的 Python 循环。关键是**批量生成 → 批量计算**。

## 模式 1: 批量采样 + 向量化 payoff

```python
import numpy as np

def monte_carlo_batched(n_samples: int, batch_size: int = 100_000) -> float:
    results = np.empty(n_samples)
    for start in range(0, n_samples, batch_size):
        end = min(start + batch_size, n_samples)
        k = end - start
        # 批量生成随机数
        z = np.random.randn(k, d)  # 或 np.random.uniform, etc.
        # 向量化 payoff 计算
        results[start:end] = payoff_vectorized(z)
    return np.mean(results)
```

## 模式 2: 对偶变量法（Antithetic Variates）

```python
z_pos = np.random.randn(batch_size // 2)
z_neg = -z_pos
results = 0.5 * (payoff(z_pos) + payoff(z_neg))
```

## 模式 3: Latin Hypercube Sampling

```python
from scipy.stats import qmc
sampler = qmc.LatinHypercube(d=dimensions)
samples = sampler.random(n=n_samples)  # 均匀分布
normal_samples = scipy.stats.norm.ppf(samples)  # 转正态分布
```

## Numba JIT 加速

对无法向量化的内层逻辑，用 `@njit`：

```python
from numba import njit

@njit
def inner_simulation(state: np.ndarray) -> float:
    # 逐步仿真逻辑
    ...
    return result
```

## 注意事项

- 随机数种子必须固定以便复现：`np.random.seed(42)` + `np.random.default_rng(seed)`
- 大 batch_size 注意内存占用
- 对高维问题 (>100 维) 优先考虑重要性采样或 MCMC
