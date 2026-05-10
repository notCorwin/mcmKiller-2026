---
name: 数据预处理
description: MCM 题目数据加载、清洗与预处理的 Python 模式
triggers:
  - "CSV"
  - "Excel"
  - "xlsx"
  - "数据清洗"
  - "缺失值"
  - "preprocessing"
  - "加载数据"
---

# 数据预处理模式

## CSV 加载

```python
import pandas as pd

df = pd.read_csv("data.csv", encoding="utf-8")
# 或带参数
df = pd.read_csv("data.csv", header=0, index_col=0, parse_dates=["date"])
```

## Excel 加载

```python
df = pd.read_excel("data.xlsx", sheet_name="Sheet1", header=0)
```

## 数据探查（只读，不修改）

```python
df.info()
df.describe()
df.head(3)
df.isnull().sum()
df.dtypes
```

## 缺失值处理

```python
# 删除含缺失值的行
df.dropna(inplace=True)

# 填充
df.fillna(df.mean(), inplace=True)      # 均值填充
df.fillna(method="ffill", inplace=True)  # 前向填充
df.interpolate(inplace=True)             # 插值
```

## 特征工程

```python
# 标准化
from sklearn.preprocessing import StandardScaler
X_scaled = StandardScaler().fit_transform(df[numeric_cols])

# One-hot 编码
df_encoded = pd.get_dummies(df, columns=["category_col"])

# 多项式特征
from sklearn.preprocessing import PolynomialFeatures
poly = PolynomialFeatures(degree=2, include_bias=False)
X_poly = poly.fit_transform(X)
```

## 大文件分块读取

```python
# 如果 CSV 太大，分块读取
chunks = []
for chunk in pd.read_csv("large.csv", chunksize=10000):
    chunks.append(chunk.describe())  # 只保留统计摘要
```
