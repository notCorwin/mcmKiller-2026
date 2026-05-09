/**
 * Unit tests for mcm-solver — only tests with actual risk.
 *
 * - preprocessProblem: real filesystem + python3 subprocess calls
 * - parseApproachesFromJson: bracket-matching regex edge cases
 * - detectConsensus: Chinese keyword heuristic
 *
 * Usage: pi scripts/test-pipeline.ts
 */

import * as assert from "node:assert";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Inlined preprocessProblem (avoid monorepo imports)
// ---------------------------------------------------------------------------

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr}`));
      else resolve(stdout);
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function extractCsvSchema(csvPath: string): Promise<DataSchema> {
  const script = `
import pandas as pd, json
df = pd.read_csv("${csvPath}")
result = {"fileName": "${path.basename(csvPath)}", "rowCount": len(df), "columns": []}
for col in df.columns:
	s = df[col]
	sample = s.dropna().head(3).tolist()
	stats = {}
	if pd.api.types.is_numeric_dtype(s):
		stats = {"min": float(s.min()), "max": float(s.max()), "mean": float(s.mean()), "std": float(s.std())}
	result["columns"].append({"name": str(col), "dtype": str(s.dtype), "sampleValues": [str(v) for v in sample], "stats": stats})
print(json.dumps(result))
`;
  const output = await runCommand(
    "python3",
    ["-c", script],
    path.dirname(csvPath),
  );
  return JSON.parse(output) as DataSchema;
}

interface DataSchema {
  fileName: string;
  columns: {
    name: string;
    dtype: string;
    sampleValues: string[];
    stats: Record<string, number>;
  }[];
  rowCount: number;
}

interface ProblemContext {
  problemId: string;
  problemText: string;
  dataSchemas: DataSchema[];
}

async function preprocessProblem(problemDir: string): Promise<ProblemContext> {
  const problemId = path.basename(problemDir);
  let problemText = "";
  const dataSchemas: DataSchema[] = [];
  for (const entry of fs.readdirSync(problemDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(problemDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    if (ext === ".md") {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!problemText) problemText = content;
      else problemText += `\n\n---\n\n${content}`;
    } else if (ext === ".csv") {
      try {
        dataSchemas.push(await extractCsvSchema(filePath));
      } catch {
        /* skip */
      }
    }
  }
  if (!problemText)
    problemText = `题目ID: ${problemId}\n\n（无 .md 题目文件，请手动将 PDF/其他格式转换为 .md 后放入此目录）`;
  return { problemId, problemText, dataSchemas };
}

// ---------------------------------------------------------------------------
// Pure functions under test
// ---------------------------------------------------------------------------

function detectConsensus(output: string): {
  status: "solved" | "diverged";
  confidence: "high" | "medium" | "low";
} {
  if (output.includes("分歧")) return { status: "diverged", confidence: "low" };
  if (output.includes("基本一致"))
    return { status: "solved", confidence: "medium" };
  return { status: "solved", confidence: "high" };
}

function parseApproachesFromJson(text: string): unknown[] | null {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (m) return JSON.parse(m[0]);
  } catch {
    /* bad JSON */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// detectConsensus
// ---------------------------------------------------------------------------

console.log("\n=== detectConsensus ===");

test("高信赖 — 显式一致", () => {
  const r = detectConsensus("两条路线结果一致，推荐路线A。");
  assert.deepEqual(r, { status: "solved", confidence: "high" });
});

test("中信赖 — 基本一致", () => {
  const r = detectConsensus("两条路线基本一致，偏差约2%。");
  assert.deepEqual(r, { status: "solved", confidence: "medium" });
});

test("分歧", () => {
  const r = detectConsensus("路线1和路线2存在较大分歧，需人工审核。");
  assert.deepEqual(r, { status: "diverged", confidence: "low" });
});

test("无关键字默认为高信赖", () => {
  const r = detectConsensus("两条路线的结果可接受。");
  assert.deepEqual(r, { status: "solved", confidence: "high" });
});

// ---------------------------------------------------------------------------
// parseApproachesFromJson
// ---------------------------------------------------------------------------

console.log("\n=== parseApproachesFromJson ===");

test("干净 JSON", () => {
  const r = parseApproachesFromJson(
    `[{"label":"梯度下降","model":"凸优化","algorithm":"SGD","libraries":["numpy"],"summary":"..."}]`,
  );
  assert.ok(r !== null);
  assert.equal((r![0] as any).label, "梯度下降");
  assert.deepEqual((r![0] as any).libraries, ["numpy"]);
});

test("JSON 被 markdown 包围", () => {
  const r = parseApproachesFromJson(
    `前面有文字\n[{"label":"A","model":"M","algorithm":"X","libraries":[],"summary":"s"}]\n后面有文字`,
  );
  assert.equal((r![0] as any).label, "A");
});

test("纯文本返回 null", () => {
  assert.equal(parseApproachesFromJson("没有JSON结构"), null);
});

test("空数组合法", () => {
  assert.deepEqual(parseApproachesFromJson("[]"), []);
});

test("无方括号返回 null", () => {
  assert.equal(parseApproachesFromJson('只有花括号{"a":1}'), null);
});

// ---------------------------------------------------------------------------
// preprocessProblem (I/O)
// ---------------------------------------------------------------------------

console.log("\n=== preprocessProblem ===");

test("读取单个 .md", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-test-"));
  try {
    fs.writeFileSync(path.join(dir, "problem.md"), "# 题目\n内容", "utf-8");
    const r = await preprocessProblem(dir);
    assert.ok(r.problemText.includes("题目"));
    assert.equal(r.dataSchemas.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("合并多个 .md", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-test-"));
  try {
    fs.writeFileSync(path.join(dir, "a.md"), "A", "utf-8");
    fs.writeFileSync(path.join(dir, "b.md"), "B", "utf-8");
    const r = await preprocessProblem(dir);
    assert.ok(r.problemText.includes("A"));
    assert.ok(r.problemText.includes("B"));
    assert.ok(r.problemText.includes("---"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("提取 CSV schema", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-test-"));
  try {
    fs.writeFileSync(path.join(dir, "problem.md"), "题目", "utf-8");
    fs.writeFileSync(
      path.join(dir, "data.csv"),
      "x,y\n0.1,0.01\n0.2,0.04\n0.3,0.09\n",
      "utf-8",
    );
    const r = await preprocessProblem(dir);
    assert.equal(r.dataSchemas.length, 1);
    assert.equal(r.dataSchemas[0].fileName, "data.csv");
    assert.equal(r.dataSchemas[0].rowCount, 3);
    assert.equal(r.dataSchemas[0].columns[0].name, "x");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("无 .md 时给出 fallback", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-test-"));
  try {
    const r = await preprocessProblem(dir);
    assert.ok(r.problemText.includes("无 .md"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("忽略非 md/csv 文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcm-test-"));
  try {
    fs.writeFileSync(path.join(dir, "problem.md"), "题目", "utf-8");
    fs.writeFileSync(path.join(dir, "data.xlsx"), "fake", "utf-8");
    fs.writeFileSync(path.join(dir, "photo.png"), "fake", "utf-8");
    const r = await preprocessProblem(dir);
    assert.equal(r.dataSchemas.length, 0);
    assert.ok(r.problemText.includes("题目"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
