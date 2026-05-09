/**
 * MCM Solver Extension
 *
 * Registers:
 *   - /solve-mcm [problemDir]: 启动一道题的完整解题流水线
 *   - solve_problem tool: LLM 可以调用的解题工具
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { preprocessProblem, type ProblemContext } from "./preprocessor.js";
import { solveProblem, type SolveConfig } from "./pipeline.js";

const DEFAULT_SOLVE_CONFIG: Omit<SolveConfig, "cwd"> = {
  maxRetries: 3,
  maxOptimizeRounds: 2,
  optimizeModel: "", // must be configured in agent frontmatter or passed explicitly
  timeoutPerPhaseMs: 900_000,
  tolerance: 0.01,
};

function formatSolveResult(
  problemId: string,
  result: Awaited<ReturnType<typeof solveProblem>>,
): string {
  const lines: string[] = [];
  lines.push(`# 解题报告: ${problemId}`);
  lines.push("");
  lines.push(`**状态**: ${result.status}`);
  lines.push("");

  if (result.status === "error") {
    lines.push(`**错误**: ${result.error}`);
    return lines.join("\n");
  }

  lines.push(`**解题路线数**: ${result.approaches.length}`);
  for (const app of result.approaches) {
    const model = app.optimizedResult?.model ?? app.codeResult.model ?? "?";
    const turns = app.codeResult.usage.turns;
    const cost = app.codeResult.usage.cost;
    lines.push(
      `- ${app.label}: model=${model}, turns=${turns}, cost=$${cost.toFixed(4)}`,
    );
  }
  lines.push("");

  if (result.consensus) {
    lines.push("## 共识结果");
    lines.push(`信心水平: ${result.consensus.confidence}`);
    lines.push("");
    lines.push("```");
    lines.push(result.consensus.result);
    lines.push("```");
    lines.push("");
    lines.push(result.consensus.recommendation);
  } else {
    lines.push("## 各路线输出");
    for (const [i, app] of result.approaches.entries()) {
      lines.push(`### ${app.label}`);
      lines.push("```");
      lines.push(app.output || "(无输出)");
      lines.push("```");
    }
  }

  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("solve-mcm", {
    description: "Solve an MCM problem from a problem directory",
    handler: async (args, ctx) => {
      const problemDir = args.trim() || "./";
      const absProblemDir = path.resolve(ctx.cwd, problemDir);

      if (!fs.existsSync(absProblemDir)) {
        if (ctx.hasUI)
          ctx.ui.notify(`Directory not found: ${absProblemDir}`, "error");
        return;
      }

      if (ctx.hasUI) ctx.ui.notify(`Preprocessing ${absProblemDir}...`, "info");

      let context: ProblemContext;
      try {
        context = await preprocessProblem(absProblemDir);
      } catch (err) {
        if (ctx.hasUI)
          ctx.ui.notify(
            `Preprocessing failed: ${(err as Error).message}`,
            "error",
          );
        return;
      }

      const config: SolveConfig = {
        ...DEFAULT_SOLVE_CONFIG,
        cwd: ctx.cwd,
      };

      if (ctx.hasUI) ctx.ui.notify(`Solving ${context.problemId}...`, "info");

      const result = await solveProblem(
        context,
        config,
        new AbortController().signal,
      );

      const report = formatSolveResult(context.problemId, result);
      const reportPath = path.join(
        ctx.cwd,
        "solutions",
        context.problemId,
        "report.md",
      );

      await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.promises.writeFile(reportPath, report, "utf-8");

      if (ctx.hasUI) {
        ctx.ui.notify(`Report saved to ${reportPath}`, "info");
      }
    },
  });

  pi.registerTool(
    defineTool({
      name: "solve_problem",
      label: "Solve MCM problem",
      description:
        "Solve a mathematical modeling competition problem end-to-end. " +
        "Preprocesses problem files, analyzes modeling approaches, " +
        "implements code for each approach, optimizes performance, " +
        "and compares results for consensus.",
      promptSnippet: "Solve MCM problems end-to-end",
      promptGuidelines: [
        "Use solve_problem to answer an MCM/COMAP-style question with data and code",
        "Point it at a directory containing the problem PDF, CSV data, etc.",
        "Results are written to solutions/<problemId>/report.md",
      ],
      parameters: Type.Object({
        problemDir: Type.String({
          description:
            "Path to the problem directory (contains .md problem text and .csv data)",
        }),
        optimizeModel: Type.Optional(
          Type.String({
            description:
              "Model to use for code optimization phase (defaults to programmer agent's model)",
          }),
        ),
        maxRetries: Type.Optional(
          Type.Number({
            description: "Max retries per failing approach",
            default: 3,
          }),
        ),
      }),

      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const problemDir = path.resolve(ctx.cwd, params.problemDir);
        if (!fs.existsSync(problemDir)) {
          return {
            content: [
              {
                type: "text",
                text: `Problem directory not found: ${problemDir}`,
              },
            ],
            details: { error: "directory_not_found" },
          };
        }

        const context = await preprocessProblem(problemDir);

        const config: SolveConfig = {
          ...DEFAULT_SOLVE_CONFIG,
          cwd: ctx.cwd,
          maxRetries: params.maxRetries ?? DEFAULT_SOLVE_CONFIG.maxRetries,
          optimizeModel:
            params.optimizeModel ?? DEFAULT_SOLVE_CONFIG.optimizeModel,
        };

        const result = await solveProblem(context, config, signal);

        const report = formatSolveResult(context.problemId, result);
        const reportDir = path.join(ctx.cwd, "solutions", context.problemId);
        const reportPath = path.join(reportDir, "report.md");

        await fs.promises.mkdir(reportDir, { recursive: true });
        await fs.promises.writeFile(reportPath, report, "utf-8");

        return {
          content: [
            {
              type: "text" as const,
              text: `${context.problemId}: status=${result.status}, ${result.approaches.length} approach(es). Report: ${reportPath}`,
            },
          ],
          details: {
            problemId: context.problemId,
            status: result.status,
            approaches: result.approaches.length,
            reportPath,
            consensus: result.consensus,
          },
        };
      },
    }),
  );
}
