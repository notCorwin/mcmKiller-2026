/**
 * Solve pipeline — orchestrates the full MCM problem-solving workflow.
 *
 * Phase 1: modeler analyzes problem → candidate models/algorithms
 * Phase 2: extractor parses analysis → structured Approach[]
 * Phase 3: modeler writes initial Python code for each approach
 * Phase 4: programmer (with stronger model) optimizes, runs, validates
 * Phase 5: analyst compares results, determines consensus or divergence
 */

import { discoverAgents } from "./agents.js";
import { runSingleAgent, getFinalOutput, type SingleResult } from "./runner.js";
import type { ProblemContext } from "./preprocessor.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SolveConfig {
  cwd: string;
  /** Max times to retry a failing approach before giving up */
  maxRetries: number;
  /** Max optimization rounds per approach */
  maxOptimizeRounds: number;
  /** Model to use for the optimization phase (programmer agent) */
  optimizeModel: string;
  /** Per-agent timeout in ms */
  timeoutPerPhaseMs: number;
  /** Relative tolerance for numerical comparison (e.g. 0.01 = 1%) */
  tolerance: number;
}

interface StructuredApproach {
  label: string;
  model: string;
  algorithm: string;
  libraries: string[];
  summary: string;
}

export interface ApproachResult {
  label: string;
  approach: StructuredApproach;
  codeResult: SingleResult;
  optimizedResult?: SingleResult;
  output: string;
}

export interface SolveResult {
  problemId: string;
  status: "solved" | "diverged" | "error";
  approaches: ApproachResult[];
  consensus?: {
    result: string;
    confidence: "high" | "medium" | "low";
    recommendation: string;
  };
  error?: string;
}

// ---------------------------------------------------------------------------
// Task builders
// ---------------------------------------------------------------------------

function formatDataSchemas(schemas: ProblemContext["dataSchemas"]): string {
  if (schemas.length === 0) return "（无 CSV 数据附件）";
  return schemas
    .map((s) => {
      const cols = s.columns
        .map((c) => {
          const stats =
            Object.keys(c.stats).length > 0
              ? `min=${c.stats.min}, max=${c.stats.max}, mean=${c.stats.mean}, std=${c.stats.std}`
              : "非数值";
          return `  - ${c.name} (${c.dtype}): 示例=[${c.sampleValues.join(", ")}], 统计=[${stats}]`;
        })
        .join("\n");
      return `### ${s.fileName} (${s.rowCount}行, ${s.columns.length}列)\n${cols}`;
    })
    .join("\n\n");
}

function buildAnalysisTask(context: ProblemContext): string {
  const schemasSection = formatDataSchemas(context.dataSchemas);
  return `## 题目正文

${context.problemText}

## 数据 Schema

${schemasSection}

请分析该题目，列出 2-3 条可行的求解路线。对每条路线给出数学模型、核心算法、Python库建议。`;
}

function buildExtractionTask(analysisOutput: string): string {
  return `请从以下分析报告中提取结构化的解题路线：

${analysisOutput}`;
}

function buildCodeTask(
  approach: StructuredApproach,
  workDir: string,
  context: ProblemContext,
): string {
  const schemasSection = formatDataSchemas(context.dataSchemas);

  return `请为以下数学建模题目编写 Python 3 解题代码。

## 求解路线: ${approach.label}
- 数学模型: ${approach.model}
- 核心算法: ${approach.algorithm}
- Python 库: ${approach.libraries.join(", ")}

## 解题摘要
${approach.summary}

## 题目正文
${context.problemText}

## 数据 Schema
${schemasSection}

## 要求
1. 编写可直接运行的 Python 3 代码（入口 main.py）
2. 最终数值结果打印到 stdout（清晰标注指标名和值）
3. 所有代码文件放在 ${workDir}/ 目录下
4. 编写完成后用 bash python3 main.py 运行确认有输出`;
}

function buildOptimizeTask(workDir: string): string {
  return `请优化 ${workDir}/ 目录下的 Python 解题代码的计算效率。

步骤:
1. 先用 read 阅读 main.py 和 solver.py（如有）
2. 用 edit 修改性能瓶颈代码
3. 用 bash python3 main.py 运行确认结果一致

优化方向:
- 向量化 (numpy broadcasting)
- JIT 编译 (numba @njit)
- 并行化
- 减少逐元素 Python 循环

如果代码已经足够高效，直接返回确认，不做无意义修改`;
}

function buildComparisonTask(
  approaches: ApproachResult[],
  tolerance: number,
): string {
  const pct = (tolerance * 100).toFixed(1);
  let task = `请比较多条解题路线的输出并判定一致性。相对误差 < ${pct}% 为一致，${pct}-5% 为可接受，> 5% 为分歧。

`;
  for (const [i, app] of approaches.entries()) {
    task += `## 路线 ${i + 1}: ${app.label} (${app.approach.model} / ${app.approach.algorithm})

\`\`\`
${app.output}
\`\`\`

`;
  }
  task += "请判断以上路线是否结果一致，并给出推荐。";
  return task;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function solveProblem(
  context: ProblemContext,
  config: SolveConfig,
  signal: AbortSignal,
): Promise<SolveResult> {
  const {
    cwd,
    maxRetries,
    maxOptimizeRounds,
    optimizeModel,
    timeoutPerPhaseMs,
    tolerance,
  } = config;
  const discovery = discoverAgents(cwd);

  const modelerAgent = discovery.agents.find((a) => a.name === "modeler");
  const extractorAgent = discovery.agents.find((a) => a.name === "extractor");
  const programmerAgent = discovery.agents.find((a) => a.name === "programmer");
  const analystAgent = discovery.agents.find((a) => a.name === "analyst");

  const missing = [];
  if (!modelerAgent) missing.push("modeler");
  if (!extractorAgent) missing.push("extractor");
  if (!programmerAgent) missing.push("programmer");
  if (!analystAgent) missing.push("analyst");
  if (missing.length > 0) {
    return {
      problemId: context.problemId,
      status: "error",
      approaches: [],
      error: `Missing agents in .pi/agents/: ${missing.join(", ")}`,
    };
  }

  // If no optimizeModel specified, use programmer agent's frontmatter model
  const effectiveOptimizeModel = optimizeModel || programmerAgent.model || "";

  if (signal.aborted) throw new Error("Aborted");

  // =========================================================================
  // Phase 1: Analyze
  // =========================================================================
  console.log(`[mcm-solver] Phase 1: Analyzing ${context.problemId}`);

  const analysisResult = await runSingleAgent(
    {
      agent: modelerAgent,
      task: buildAnalysisTask(context),
      cwd,
      timeoutMs: timeoutPerPhaseMs,
    },
    signal,
  );
  const analysisOutput = getFinalOutput(analysisResult.messages);
  if (!analysisOutput) {
    return {
      problemId: context.problemId,
      status: "error",
      approaches: [],
      error: "Modeler produced no output",
    };
  }
  console.log(
    `[mcm-solver] Phase 1: ${analysisResult.usage.turns} turns, ${analysisOutput.length} chars`,
  );

  // =========================================================================
  // Phase 2: Extract structured approaches
  // =========================================================================
  console.log("[mcm-solver] Phase 2: Extracting approaches");

  const extractionResult = await runSingleAgent(
    {
      agent: extractorAgent,
      task: buildExtractionTask(analysisOutput),
      cwd,
      timeoutMs: Math.min(timeoutPerPhaseMs, 300_000), // extractor
    },
    signal,
  );
  const extractionOutput = getFinalOutput(extractionResult.messages);

  let parsedApproaches: StructuredApproach[] = [];
  try {
    const jsonMatch = extractionOutput.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      parsedApproaches = JSON.parse(jsonMatch[0]) as StructuredApproach[];
    }
  } catch {
    // fallback: single approach from analysis
  }

  if (parsedApproaches.length === 0) {
    console.log(
      "[mcm-solver] Phase 2: extraction returned 0 approaches, using full analysis as single approach",
    );
    parsedApproaches = [
      {
        label: "路线 1",
        model: "（见分析报告）",
        algorithm: "（见分析报告）",
        libraries: [],
        summary: analysisOutput.slice(0, 500),
      },
    ];
  }
  console.log(
    `[mcm-solver] Phase 2: ${parsedApproaches.length} approach(es) extracted`,
  );

  // =========================================================================
  // Phase 3 + 4: Code + Optimize for each approach
  // =========================================================================
  const approaches: ApproachResult[] = [];
  const codeErrors: string[] = [];

  for (let i = 0; i < parsedApproaches.length; i++) {
    if (signal.aborted) throw new Error("Aborted");

    const approach = parsedApproaches[i];
    const workDir = `problems/${context.problemId}/work/approach-${i + 1}`;
    console.log(
      `[mcm-solver] Phase 3: ${approach.label} — writing code → ${workDir}`,
    );

    // Phase 3: modeler writes initial code (with retry)
    let codeResult: SingleResult | undefined;
    let codeRetries = 0;
    while (codeRetries < maxRetries) {
      if (signal.aborted) throw new Error("Aborted");

      codeResult = await runSingleAgent(
        {
          agent: modelerAgent,
          task: buildCodeTask(approach, workDir, context),
          cwd,
          timeoutMs: timeoutPerPhaseMs,
        },
        signal,
      );

      if (codeResult.exitCode === 0 && !codeResult.errorMessage) break;

      codeRetries++;
      console.log(
        `[mcm-solver] Phase 3 retry ${codeRetries}/${maxRetries}: ${approach.label} — ${codeResult.errorMessage || `exit=${codeResult.exitCode}`}`,
      );
    }

    if (!codeResult || (codeResult.exitCode !== 0 && codeResult.errorMessage)) {
      const msg = codeResult?.errorMessage || `exit=${codeResult?.exitCode}`;
      codeErrors.push(`${approach.label}: ${msg}`);
      console.log(
        `[mcm-solver] Phase 3: ${approach.label} failed after ${maxRetries} retries, skipping`,
      );
      continue;
    }

    let output = getFinalOutput(codeResult.messages);
    let optimizedResult: SingleResult | undefined;

    // Phase 4: programmer optimizes with the stronger model
    let optimizeSucceeded = false;
    for (let round = 0; round < maxOptimizeRounds; round++) {
      if (signal.aborted) throw new Error("Aborted");

      console.log(
        `[mcm-solver] Phase 4: ${approach.label} round ${round + 1}/${maxOptimizeRounds}`,
      );

      let retries = 0;
      let roundCompleted = false;
      while (retries < maxRetries) {
        const optResult = await runSingleAgent(
          {
            agent: programmerAgent,
            task: buildOptimizeTask(workDir),
            cwd,
            modelOverride: effectiveOptimizeModel || undefined,
            timeoutMs: timeoutPerPhaseMs,
          },
          signal,
        );

        if (optResult.exitCode !== 0 || optResult.errorMessage) {
          retries++;
          console.log(
            `[mcm-solver] Phase 4 retry ${retries}/${maxRetries}: ${approach.label} — ${optResult.errorMessage || `exit=${optResult.exitCode}`}`,
          );
          continue;
        }

        const newOutput = getFinalOutput(optResult.messages);
        optimizeSucceeded = true;
        roundCompleted = true;
        optimizedResult = optResult;

        if (newOutput && newOutput !== output) {
          output = newOutput;
          console.log(
            `[mcm-solver] Phase 4: ${approach.label} output changed (${newOutput.length} chars)`,
          );
        }
        break;
      }

      if (!roundCompleted) {
        console.log(
          `[mcm-solver] Phase 4: ${approach.label} exhausted ${maxRetries} retries in round ${round + 1}, stopping optimization`,
        );
        break;
      }
    }

    approaches.push({
      label: approach.label,
      approach,
      codeResult,
      optimizedResult,
      output,
    });

    console.log(
      `[mcm-solver] ${approach.label}: code=${codeResult.usage.turns} turns, opt=${optimizeSucceeded ? "yes" : "no"}`,
    );
  }

  if (approaches.length === 0 && codeErrors.length > 0) {
    return {
      problemId: context.problemId,
      status: "error",
      approaches: [],
      error: `All approaches failed: ${codeErrors.join("; ")}`,
    };
  }

  // =========================================================================
  // Phase 5: Compare
  // =========================================================================
  console.log("[mcm-solver] Phase 5: Comparing results");

  const comparisonResult = await runSingleAgent(
    {
      agent: analystAgent,
      task: buildComparisonTask(approaches, tolerance),
      cwd,
      timeoutMs: Math.min(timeoutPerPhaseMs, 120_000),
    },
    signal,
  );
  const comparisonOutput = getFinalOutput(comparisonResult.messages);

  let status: SolveResult["status"] = "solved";
  let confidence: SolveResult["consensus"]["confidence"] = "medium";

  if (comparisonOutput.includes("分歧")) {
    status = "diverged";
    confidence = "low";
  } else if (comparisonOutput.includes("基本一致")) {
    status = "solved";
    confidence = "medium";
  } else if (comparisonOutput.includes("一致")) {
    status = "solved";
    confidence = "high";
  }

  let consensus: SolveResult["consensus"] | undefined;
  if (status === "solved") {
    consensus = {
      result: approaches[approaches.length - 1].output,
      confidence,
      recommendation: comparisonOutput,
    };
  }

  return { problemId: context.problemId, status, approaches, consensus };
}
