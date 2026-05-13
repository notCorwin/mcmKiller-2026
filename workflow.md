# 工作流设计

**默认工作目录**： 假设 [@workflow.ts] 所在目录为\mcmKiller，则工作目录为\mcmKiller\work_yyyyMMdd_HHmmss文件夹（下文用\work代替）。每次启动都需要创建新文件夹。
**全局工作要求**：

1. 本条工作流中的所有文档必须使用中文撰写。
2. 工作流所需的提示词均在\.pi\prompts中有对应文件。

## Restatement

新建Pi会话记为Session Restatement，重述问题为后续“问题分析”和“建模”铺路，创建新文件夹\work\Q1～\work\Qn，并将问题拆分成Q1.md～Qn.md到各自的文件夹，并删除原始题目文件。不要删除题目附件。

## Assumptions
新建Pi会话记为Session Assumptions，重新阅读Q1.md～Qn.md，约定合适的模型假设，以简化现实问题，方便建模。然后分点写入\work\assumptions.md。

## Analysis｜Modeling｜Solving

```
对第 i 道题（i = 1, 2, …, n）依次执行下面的操作，其中 n 为题目总数
  将Pi的工作目录设置到\work\Qi
  将Session Assumptions导入到新会话中，记为Session Analysis-Qi
  分析Qi.md，列举出所有高效且具有创新性的解题思路 m 条
  为每条解题思路创建一个文件夹（\work\Qi\approach_1到\work\Qi\approach_m）
  为每条解题思路写一份文档analysis.md到各自思路的文件夹中
  对第 j 条思路（j = 1, 2, …, m）依次执行下面的操作，其中 m 为思路条数
    将Pi的工作目录设置到\work\Qi\approach_j
    将Session Analysis-Qi导入到新会话中，记为Session Qi-approach_j
    基于approach_j建立模型（此步不使用代码求解）
    保留建模的思路历程到\work\Qi\approach_j\modeling.md，用于后续论文的撰写
    创建新文件夹\work\Qi\approach_j\solving
    将Pi的工作目录设置到\work\Qi\approach_j\solving
    继续延用Session Qi-approach_j的上下文，开始编写解题代码
    将结果写入result.md
  将Pi的工作目录设置到\work\Qi
  交叉比对所有approach_j\solving\result.md，分析不同approach答案不同的原因。并判定是否需要改进某一approach的代码。将result、误差原因、判定结果写到summary.md
```
