/**
 * Batch solver — 遍历 problems/ 下所有题目，逐题求解。
 *
 * Usage:
 *   pi scripts/solve-all.ts
 *   pi scripts/solve-all.ts --problem 2025/problem-a  # 只解指定题目
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { discoverAgents } from "../.pi/extensions/mcm-solver/agents.js";
import { preprocessProblem } from "../.pi/extensions/mcm-solver/preprocessor.js";
import {
  solveProblem,
  type SolveConfig,
} from "../.pi/extensions/mcm-solver/pipeline.js";

const CONFIG: Omit<SolveConfig, "cwd"> = {
  maxRetries: 3,
  maxOptimizeRounds: 2,
  optimizeModel: "",
  timeoutPerPhaseMs: 300_000,
  tolerance: 0.01,
};

function formatSolveResult(
  problemId: string,
  result: Awaited<ReturnType<typeof solveProblem>>,
): string {
  const lines: string[] = [];
  lines.push(`# 解题报告: ${problemId}`);
  lines.push(`**状态**: ${result.status}`);
  if (result.status === "error") {
    lines.push(`**错误**: ${result.error}`);
    return lines.join("\n");
  }
  for (const app of result.approaches) {
    const model = app.optimizedResult?.model ?? app.codeResult.model ?? "?";
    lines.push(
      `- ${app.label}: ${model}, ${app.codeResult.usage.turns} turns, $${app.codeResult.usage.cost.toFixed(4)}`,
    );
  }
  if (result.consensus) {
    lines.push(`**共识**: ${result.consensus.confidence} confidence`);
  }
  return lines.join("\n");
}

function findProblemDirs(problemsRoot: string): string[] {
  const dirs: string[] = [];
  const entries = fs.readdirSync(problemsRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subPath = path.join(problemsRoot, entry.name);
    const subEntries = fs.readdirSync(subPath, { withFileTypes: true });
    for (const sub of subEntries) {
      if (sub.isDirectory()) {
        dirs.push(path.join(subPath, sub.name));
      }
    }
    // If the year dir itself has problem files, include it
    if (subEntries.some((e) => e.isFile())) {
      dirs.push(subPath);
    }
  }
  return dirs;
}

async function main() {
  const cwd = process.cwd();
  const problemsRoot = path.join(cwd, "problems");

  if (!fs.existsSync(problemsRoot)) {
    console.error("No problems/ directory found");
    process.exit(1);
  }

  let problemDirs = findProblemDirs(problemsRoot);

  // Check for --problem flag
  const problemArg = process.argv.find((a) => a.startsWith("--problem="));
  if (problemArg) {
    const target = problemArg.split("=")[1];
    const targetPath = path.resolve(cwd, target);
    if (fs.existsSync(targetPath)) {
      problemDirs = [targetPath];
    } else {
      console.error(`Problem not found: ${targetPath}`);
      process.exit(1);
    }
  }

  if (problemDirs.length === 0) {
    console.log("No problems found in problems/");
    process.exit(0);
  }

  console.log(`Found ${problemDirs.length} problem(s):`);
  for (const dir of problemDirs) {
    console.log(`  - ${path.relative(cwd, dir)}`);
  }
  console.log("");

  const discovery = discoverAgents(cwd);
  const programmerAgent = discovery.agents.find((a) => a.name === "programmer");
  const config: SolveConfig = {
    ...CONFIG,
    optimizeModel: CONFIG.optimizeModel || programmerAgent?.model || "",
    cwd,
  };
  const abortController = new AbortController();

  // Sequential solving (MCM problems may have inter-dependent insights)
  for (const problemDir of problemDirs) {
    const problemId = path.relative(cwd, problemDir);
    console.log(`\n=== ${problemId} ===`);

    let context;
    try {
      context = await preprocessProblem(problemDir);
    } catch (err) {
      console.error(`Preprocessing failed: ${(err as Error).message}`);
      continue;
    }

    try {
      const result = await solveProblem(
        context,
        config,
        abortController.signal,
      );
      const report = formatSolveResult(problemId, result);

      const reportDir = path.join(cwd, "solutions", path.basename(problemDir));
      const reportPath = path.join(reportDir, "report.md");
      await fs.promises.mkdir(reportDir, { recursive: true });
      await fs.promises.writeFile(reportPath, report, "utf-8");

      console.log(report);
      console.log(`Report saved: ${reportPath}`);
    } catch (err) {
      console.error(`Solve failed: ${(err as Error).message}`);
    }
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
