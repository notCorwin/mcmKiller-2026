/**
 * Problem preprocessor — minimal: only scans .md (problem text) and .csv (schema).
 * All other formats (PDF, Excel, .mat, images) must be manually converted beforehand.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface DataSchema {
  fileName: string;
  columns: {
    name: string;
    dtype: string;
    sampleValues: string[];
    stats: Record<string, number>;
  }[];
  rowCount: number;
}

export interface ProblemContext {
  problemId: string;
  problemText: string;
  dataSchemas: DataSchema[];
}

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
  const pythonScript = `
import pandas as pd, json
df = pd.read_csv("${csvPath}")
result = {
	"fileName": "${path.basename(csvPath)}",
	"rowCount": len(df),
	"columns": []
}
for col in df.columns:
	series = df[col]
	sample = series.dropna().head(3).tolist()
	stats = {}
	if pd.api.types.is_numeric_dtype(series):
		stats = {"min": float(series.min()), "max": float(series.max()), "mean": float(series.mean()), "std": float(series.std())}
	result["columns"].append({
		"name": str(col),
		"dtype": str(series.dtype),
		"sampleValues": [str(v) for v in sample],
		"stats": stats
	})
print(json.dumps(result))
`;
  const output = await runCommand(
    "python3",
    ["-c", pythonScript],
    path.dirname(csvPath),
  );
  return JSON.parse(output) as DataSchema;
}

export async function preprocessProblem(
  problemDir: string,
): Promise<ProblemContext> {
  const problemId = path.basename(problemDir);
  let problemText = "";
  const dataSchemas: DataSchema[] = [];

  const entries = fs.readdirSync(problemDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(problemDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();

    if (ext === ".md") {
      const content = fs.readFileSync(filePath, "utf-8");
      if (!problemText) problemText = content;
      else problemText += `\n\n---\n\n${content}`;
    } else if (ext === ".csv") {
      try {
        const schema = await extractCsvSchema(filePath);
        dataSchemas.push(schema);
      } catch {
        // silently skip unparseable CSVs
      }
    }
  }

  if (!problemText) {
    problemText = `题目ID: ${problemId}\n\n（无 .md 题目文件，请手动将 PDF/其他格式转换为 .md 后放入此目录）`;
  }

  return { problemId, problemText, dataSchemas };
}
