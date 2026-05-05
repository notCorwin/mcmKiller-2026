# Python 数值性能优化 (M 系列芯片)

## 核心思想

Python 是胶水语言，重活交给底层库。MATLAB 同理，靠底层 C/Fortran 库。

## 优化三步走

### 第一步 — 环境调优

**确保 arm64 原生环境**

- 用 Miniforge/mamba 建 osx-arm64 环境
- 不走 Rosetta 转译

**NumPy 绑定高性能 BLAS**

优先 Apple Accelerate：

- macOS 14+ & NumPy 2.x 原生支持
- 社区基准: Accelerate 比 OpenBLAS 更快

安装：

```
conda install libblas=*=*accelerate
```

备选：从源码编译 NumPy。

**验证 BLAS 生效**

- 做大矩阵乘法/SVD benchmark
- M1 实测：NumPy 矩阵乘 2.26s vs MATLAB 4.73s

### 第二步 — 数值代码编写习惯

**避免纯 Python 循环，改向量化**

- 用 NumPy 广播、矩阵乘、批量运算
- 典型坑：初学者用 for 循环导致慢一个数量级

**合适的数据结构与算法**

- 稀疏矩阵用 SciPy 稀疏矩阵专用算法
- 重复求解线性系统时重用 LU/Cholesky 分解

### 第三步 — 热点编译加速

**Numba 编译本地代码**

```python
from numba import njit

@njit
def compute(x):
    ...

@njit(parallel=True)
def compute_parallel(x):
    ...
```

- 适用：复杂状态更新 / Monte Carlo / 离散仿真
- M1 支持：Numba 0.55.2+

**Cython / 手写扩展**

- 适用：极端性能敏感的自定义核 / PDE 局部更新
- 彻底脱离 Python 解释层

**Numba + Metal GPU**

```bash
pip install metaxuda
```

- 适用：矩阵乘 / 卷积 / 粒子模拟等高度并行任务
- GPU 利用率可达 90%+

## 实用 Workflow

### 第一步 — 写出干净的向量化版本

- 矩阵/向量运算 → NumPy
- 微分方程/优化/插值 → SciPy 高层接口
- 此时性能已接近理论上限

### 第二步 — 用 cProfile 定位瓶颈

```bash
python -m cProfile -s cumulative your_script.py
```

- 瓶颈是 BLAS/SciPy 调用 → 已接近 MATLAB
- 瓶颈是 Python 循环 → 进入下一步

### 第三步 — Numba/Cython 加速热点

- 对最慢 1~3 个函数用 `@njit`
- 有并行结构用 `parallel=True`
- 能获得数量级提速

### 第四步 — M 芯片特色调优

- 增大批处理粒度，充分利用大缓存和高带宽
- 高度并行任务评估接入 Metal GPU
