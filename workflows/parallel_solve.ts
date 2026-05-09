#!/usr/bin/env node
/**
 * solve.ts — MCM 解题工作流
 *
 * 分析题目 → 提取解题思路 → fork 出 N 个 Session 并行编码 → 交叉比对
 *
 * 用法:
 *   npx tsx workflows/solve.ts <problem.md> [--model provider/id]
 *
 * 流程:
 *   1. 分析 Agent 读题，列出若干解题思路
 *   2. 每个思路 fork 一个 Session（继承题目上下文），追加"按思路 X 实现"
 *   3. 所有 coding Session 并行运行，输出到 work/approach-N/
 *   4. 交叉比对 Agent 审阅所有代码，给出推荐
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join, dirname } from "path";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

// ─── 类型 ────────────────────────────────────────────────────

interface Result {
  index: number;
  name: string;
  files: Map<string, string>;
  success: boolean;
  error?: string;
}

// ─── 配置 ────────────────────────────────────────────────────

const PROBLEM_FILE = process.argv[2];
if (!PROBLEM_FILE || !existsSync(PROBLEM_FILE)) {
  console.error(
    "用法: npx tsx workflows/solve.ts <problem.md> [--model provider/id]",
  );
  process.exit(1);
}
const problem = readFileSync(PROBLEM_FILE, "utf-8");
const WORK_DIR = dirname(PROBLEM_FILE);
const WORK_BASE = join(WORK_DIR, "work");

const modelFlag = process.argv.findIndex((a) => a === "--model");
const MODEL_SPEC = modelFlag !== -1 ? process.argv[modelFlag + 1] : null;
const [MODEL_PROVIDER, MODEL_ID] = MODEL_SPEC?.split("/") ?? [
  "openrouter",
  "deepseek/deepseek-v4-flash",
];

// ─── 基础设施 ────────────────────────────────────────────────

function log(phase: string, msg: string) {
  console.log(`[${phase}] ${msg}`);
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function collectFiles(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  function walk(d: string) {
    if (!existsSync(d)) return;
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(full, readFileSync(full, "utf-8"));
    }
  }
  walk(dir);
  return files;
}

function lastAssistantText(messages: any[]): string {
  const last = [...messages].reverse().find((m) => m.role === "assistant");
  if (!last) throw new Error("未找到 assistant 回复");
  const content = last.content;
  if (typeof content === "string") return content;
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("  MCM 解题工作流");
  console.log(`  题目: ${PROBLEM_FILE}`);
  console.log(`  模型: ${MODEL_PROVIDER}/${MODEL_ID}`);
  console.log("=".repeat(60));

  if (existsSync(WORK_BASE)) rmSync(WORK_BASE, { recursive: true });
  ensureDir(WORK_BASE);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = getModel(MODEL_PROVIDER, MODEL_ID);
  if (!model) throw new Error(`模型 ${MODEL_PROVIDER}/${MODEL_ID} 未找到`);

  // ── 1. 分析题目 ──────────────────────────────────────────

  log("分析", "开始分析...");

  const analysisSM = SessionManager.create(WORK_DIR);
  const analysis = await createAgentSession({
    sessionManager: analysisSM,
    authStorage,
    modelRegistry,
    model,
  });

  await analysis.session.prompt(
    [
      "分析这道 MCM 竞赛题目，列出至少 3 种不同的解题思路。",
      "每种思路在数学建模方法上要有本质差异。",
      "输出格式（严格按此格式）：",
      "思路1：方法名称",
      "  简短描述",
      "思路2：方法名称",
      "  简短描述",
    ].join("\n"),
  );

  const replyText = lastAssistantText(analysis.session.messages);
  console.log("\n分析结果：\n" + replyText + "\n");

  const approachNames = replyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^思路\d+[：:]/.test(l))
    .map((l) => {
      const m = l.match(/^思路\d+[：:]\s*(.+)/);
      return m ? m[1].trim() : l;
    });

  if (approachNames.length === 0) {
    throw new Error("无法解析出解题思路");
  }

  approachNames.forEach((n, i) => console.log(`  ${i + 1}. ${n}`));

  // ── 2. Fork ────────────────────────────────────────────

  log("Fork", `从问题消息分叉 ${approachNames.length} 个 Session...`);

  // createBranchedSession 会变异原 SessionManager，只能调用一次。
  // 保存原始 session 文件路径，每个 fork 都从原始文件重新打开。
  const originalSessionFile = analysisSM.getSessionFile();
  if (!originalSessionFile) throw new Error("分析 session 未持久化，无法 fork");

  const entries = analysisSM.getEntries();
  const problemEntry = entries.find(
    (e): e is SessionMessageEntry =>
      e.type === "message" && e.message.role === "user",
  );
  if (!problemEntry) throw new Error("未找到问题消息");

  const codingSessions = await Promise.all(
    approachNames.map(async (name, i) => {
      const dir = join(WORK_BASE, `approach-${i + 1}`);
      ensureDir(dir);

      // 从原始 session 文件重新打开，避免交错变异
      const sm = SessionManager.open(originalSessionFile);
      const forkPath = sm.createBranchedSession(problemEntry.id);
      if (!forkPath) throw new Error(`Fork 失败: 思路 ${i + 1}`);

      const forkSM = SessionManager.open(forkPath);
      forkSM.appendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `请按「${name}」思路编写完整 MCM 解题代码。`,
              `工作目录: ${dir}`,
              "代码必须可独立运行，包含建模、求解、可视化。",
              "图表保存为 PNG，最终输出 summary.md 说明建模过程。",
            ].join("\n"),
          },
        ],
        timestamp: Date.now(),
      });

      const { session } = await createAgentSession({
        sessionManager: forkSM,
        authStorage,
        modelRegistry,
        model,
      });

      return { index: i, name, session, dir };
    }),
  );

  // ── 3. 并行编码 ────────────────────────────────────────

  log("编码", `启动 ${codingSessions.length} 个 Agent 并行编码...\n`);

  const startTime = Date.now();
  const settled = await Promise.allSettled(
    codingSessions.map((cs) => cs.session.prompt("开始编写代码")),
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  log("编码", `全部完成，耗时 ${elapsed} 秒\n`);

  // ── 4. 收集结果 ────────────────────────────────────────

  const results: Result[] = [];

  for (let i = 0; i < codingSessions.length; i++) {
    const cs = codingSessions[i];
    const r = settled[i];

    if (r.status === "rejected") {
      console.log(`  \u274c 思路 ${i + 1}「${cs.name}」失败: ${r.reason}`);
      results.push({
        index: cs.index,
        name: cs.name,
        files: new Map(),
        success: false,
        error: String(r.reason),
      });
    } else {
      const files = collectFiles(cs.dir);
      console.log(`  \u2705 思路 ${i + 1}「${cs.name}」: ${files.size} 个文件`);
      results.push({ index: cs.index, name: cs.name, files, success: true });
    }

    cs.session.dispose();
  }

  // ── 5. 交叉比对 ──────────────────────────────────────

  log("比对", "启动交叉比对 Agent...\n");

  const report = [
    "# 题目\n",
    problem,
    "\n# 各思路代码\n",
    ...results.map((r) =>
      [
        `## 思路 ${r.index + 1}：${r.name} ${r.success ? "" : "(失败)"}`,
        r.error ? `错误: ${r.error}` : "",
        ...Array.from(r.files.entries()).map(
          ([path, content]) => `### ${path}\n\`\`\`\n${content}\n\`\`\``,
        ),
      ].join("\n"),
    ),
  ].join("\n");

  const reviewSM = SessionManager.inMemory();
  const review = await createAgentSession({
    sessionManager: reviewSM,
    authStorage,
    modelRegistry,
    model,
  });

  await review.session.prompt(
    [
      "你是一位 MCM 竞赛评审专家。请审阅以下解题代码。",
      "",
      report,
      "",
      "请输出评审报告：",
      "1. 每个思路的优缺点",
      "2. 横向对比表格（建模合理性、代码质量、创新性）",
      "3. 最终推荐哪个思路作为正式提交方案，并说明理由",
    ].join("\n"),
  );

  const reviewText = lastAssistantText(review.session.messages);
  const reportPath = join(WORK_BASE, "review-report.md");
  writeFileSync(reportPath, reviewText, "utf-8");

  console.log(reviewText);
  console.log(`\n报告已保存: ${reportPath}`);

  review.session.dispose();
  analysis.session.dispose();

  // 清理 session 文件
  const sessionDir = analysisSM.getSessionDir();
  if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true });

  console.log("\n" + "=".repeat(60));
  console.log("  工作流完成");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("工作流出错:", err);
  process.exit(1);
});
