我们正在参与数学建模比赛。为了顺利完赛，我们需要完成以下工作：

## 目录结构

```
.
├── AGENTS.md
├── README.md                  ← 赛题原文
├── reference.bib              ← 参考文献 BibTeX
├── thePaper.tex               ← 主论文 LaTeX 源文件
│
├── SolutionMethodology/       ← 各题建模思路文档
│   ├── Q1Strategy.md
│   ├── Q2Strategy.md
│   ├── Q3Strategy.md
│   ├── Q4Strategy.md
│   └── Q5Strategy.md
│
├── MATLAB/                    ← 各题求解脚本
│   ├── solveQ1.m
│   ├── solveQ2.m
│   ├── solveQ3.m
│   ├── solveQ4.m
│   └── solveQ5.m
│
├── Scripts/                   ← 辅助脚本
│   ├── buildAssets.m          ← 生成论文所需图表 / 表格
│   └── runAllMatlab.m         ← 一键运行所有求解脚本
│
├── Output/
│   ├── Results/               ← 求解结果（供论文引用数值）
│   │   └── Q1Result
│   ├── Figures/               ← 论文用图（由 buildAssets.m 生成）
│   └── Tables/                ← 论文用表（由 buildAssets.m 生成）
│
└── References/                ← 参考文献原文 / 资料
```

## 工作流程

### 一、建立模型（@/SolutionMethodology/)

为每道赛题选择最合适的模型与算法，并以 Markdown 文档形式记录在对应策略文件中：

- 问题分析与假设
- 模型选择依据
- 数学表达与公式
- 算法步骤描述
- 预期输出说明

---

### 二、编写脚本（@/MATLAB/）

根据策略文档编写对应求解脚本。输出结果保存至 `@/Output/Results/` 供论文引用。

| 脚本 | 对应策略 | 输出文件 |
|------|----------|----------|
| `solveQ1.m` | `Q1Strategy.md` | `Results/Q1Result` |
| `solveQ2.m` | `Q2Strategy.md` | `Results/Q2Result` |
| `solveQ3.m` | `Q3Strategy.md` | `Results/Q3Result` |
| `solveQ4.m` | `Q4Strategy.md` | `Results/Q4Result` |
| `solveQ5.m` | `Q5Strategy.md` | `Results/Q5Result` |

**辅助脚本**：`Scripts/buildAssets.m` 负责生成论文所需的图表与表格，输出至 `@/Output/Figures/` 和 `@/Output/Tables/`。

---

### 三、编写论文（@/thePaper.tex）

- `@/thePaper.tex` 是以前的成功论文。但是写的不是这个题目。写论文时在原有基础上替换内容即可，不要替换格式。
- 严格遵循 [`@/RequirementsForPaper.md`](./RequirementsForPaper.md) 中的结构与格式要求
- 数值结果引用 `@/Output/Results/` 中的数据
- 图表引用 `@/Output/Figures/` 与 `@/Output/Tables/` 中的资源
- 参考文献使用 `@/reference.bib`，文献原文存放在 `@/References/`
- **论文附录 B** 需包含 `@/MATLAB/` 中所有求解脚本的完整代码