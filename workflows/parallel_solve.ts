#!/usr/bin/env node
/**
 * parallel_solve.ts — MCM 逐题工作流
 *
 * 分析单道题目 → fork 出 N 个 Session 并行编码 → 交叉比对 → 输出 summary
 *
 * 用法:
 *   node workflows/parallel_solve.ts past_mcm/CUMCM-2025-A/Q1.md
 *   node workflows/parallel_solve.ts past_mcm/CUMCM-2025-A/Q2.md \
 *     --context past_mcm/CUMCM-2025-A/work/Q1/summary.md
 *
 * 参数:
 *   <file>                   问题 markdown 文件
 *   --context <path>         前一问的 summary.md（可多次）
 *   --model <provider/id>    模型选择
 *   --approaches <number>    解题思路数量（默认 3）
 *   --no-review              跳过评审阶段
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
setGlobalDispatcher(
  new EnvHttpProxyAgent({ bodyTimeout: 0, headersTimeout: 0 }),
);

import {
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readdirSync,
} from "fs";
import { join, dirname, basename } from "path";
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  defineTool,
} from "@mariozechner/pi-coding-agent";
import { getModel } from "@mariozechner/pi-ai";

// ─── 解析参数 ────────────────────────────────────────────────

const args = process.argv.slice(2);
const PROBLEM_FILE = args[0];
if (!PROBLEM_FILE || !existsSync(PROBLEM_FILE)) {
  console.error(
    "用法: node workflows/parallel_solve.ts <Q.md> [--context ...] [--model provider/id]",
  );
  process.exit(1);
}

const contextFiles: string[] = [];
let modelFlagIdx = args.indexOf("--model");
let approachesFlagIdx = args.indexOf("--approaches");
const SKIP_REVIEW = args.includes("--no-review");

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--context" && args[i + 1]) contextFiles.push(args[++i]);
}

const MODEL_SPEC =
  modelFlagIdx !== -1 ? args[modelFlagIdx + 1]?.split("/") : null;
const [MODEL_PROVIDER, MODEL_ID] = MODEL_SPEC ?? [
  "openrouter",
  "deepseek/deepseek-v4-flash",
];
const APPROACHES_COUNT =
  approachesFlagIdx !== -1 ? parseInt(args[approachesFlagIdx + 1]) || 3 : 3;

const problem = readFileSync(PROBLEM_FILE, "utf-8");
const Q_DIR = dirname(PROBLEM_FILE);
const Q_NAME = basename(PROBLEM_FILE, ".md");
const WORK_BASE = join(Q_DIR, "work", Q_NAME);

// ─── 类型 ────────────────────────────────────────────────────

interface Approach {
  index: number;
  name: string;
}

interface Result {
  index: number;
  name: string;
  files: Map<string, string>;
  success: boolean;
  error?: string;
}

// ─── CaptureTerminal：为每个 Session 生成类原生终端日志 ─────

interface TerminalWriteOptions {
  /** 追加到文件时写入标签，例如 `[TOOL bash]` */
  tag?: string;
  /** 强制换行 */
  newline?: boolean;
}

/**
 * CaptureTerminal 模拟 pi TUI 的 Terminal 接口，
 * 将每个 Session 的完整输出（文本增量、thinking、工具执行、轮次信息）
 * 记录为一份类原生终端风格的日志文件，同时保持实时 stdout 输出。
 */
class CaptureTerminal {
  private chunks: string[] = [];
  private filePath: string;
  private label: string;
  private toolStack: string[] = [];

  constructor(filePath: string, label: string) {
    this.filePath = filePath;
    this.label = label;
  }

  /** 写入文本（模拟 Terminal.write） */
  write(data: string, opts?: TerminalWriteOptions): void {
    const tag = opts?.tag ? `[${opts.tag}] ` : "";
    process.stdout.write(data);
    this.chunks.push(tag + data);
  }

  /** 写入一行（模拟 Terminal.writeln） */
  writeln(data: string, opts?: TerminalWriteOptions): void {
    this.write(data + "\n", opts);
  }

  /** 写入分隔线 */
  hr(char = "─", width = 60): void {
    const line = char.repeat(width);
    this.writeln(`\x1b[2m${line}\x1b[22m`, { newline: true });
  }

  /** Agent 开始 */
  onAgentStart(): void {
    this.hr();
    this.writeln(`  AGENT START  ${this.label}`);
    this.hr();
  }

  /** Agent 结束 */
  onAgentEnd(): void {
    this.hr();
    this.writeln(`  AGENT END  ${this.label}`);
    this.hr();
    this.writeln("");
  }

  /** 轮次开始 */
  onTurnStart(turn: number): void {
    this.hr("-", 40);
    this.writeln(`  Turn ${turn}`);
    this.hr("-", 40);
  }

  /** 助手文本增量 */
  onTextDelta(delta: string): void {
    this.write(delta, { tag: "assistant" });
  }

  /** 思考增量 */
  onThinkingDelta(delta: string): void {
    this.write(delta, { tag: "thinking" });
  }

  /** 工具开始执行 */
  onToolStart(name: string, args: any): void {
    this.toolStack.push(name);
    const argsStr =
      typeof args === "string"
        ? args.slice(0, 200)
        : JSON.stringify(args).slice(0, 200);
    this.writeln(`\x1b[36m▸ ${name}\x1b[0m`, { tag: "tool" });
    if (argsStr) {
      this.writeln(`  args: ${argsStr}`, { tag: "tool" });
    }
  }

  /** 工具执行增量输出 */
  onToolUpdate(text: string): void {
    if (!text) return;
    // 保留 ANSI 以还原终端效果
    this.write(text);
  }

  /** 工具执行结束 */
  onToolEnd(name: string, isError: boolean): void {
    this.toolStack.pop();
    const icon = isError ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
    this.writeln(`  ${icon} ${name} ${isError ? "(error)" : "(done)"}`);
  }

  /** 重试开始 */
  onRetryStart(attempt: number, maxAttempts: number): void {
    this.writeln(`\x1b[33m⟳ 重试 ${attempt}/${maxAttempts}\x1b[0m`, {
      tag: "retry",
    });
  }

  /** 压缩 */
  onCompactionStart(): void {
    this.writeln(`\x1b[33m⊡ 压缩上下文...\x1b[0m`, { tag: "compaction" });
  }

  /** 将捕获的内容写入日志文件 */
  flush(): void {
    // 写入原始内容（保留 ANSI），近似终端原生效果
    const raw = this.chunks.join("");
    writeFileSync(this.filePath, raw, "utf-8");

    // 同时写入去 ANSI 的纯文本版本
    const plainPath = this.filePath.replace(/\.log$/, ".txt");
    writeFileSync(plainPath, stripAnsiCodes(raw), "utf-8");
  }
}

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
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function subscribeSession(
  label: string,
  session: any,
  terminal: CaptureTerminal,
): () => void {
  let turnCount = 0;

  return session.subscribe((event: any) => {
    switch (event.type) {
      case "agent_start":
        terminal.onAgentStart();
        break;

      case "agent_end":
        terminal.onAgentEnd();
        break;

      case "turn_start":
        turnCount++;
        terminal.onTurnStart(turnCount);
        break;

      case "message_update": {
        const ev = event.assistantMessageEvent;
        if (ev.type === "text_delta") {
          terminal.onTextDelta(ev.delta);
        } else if (ev.type === "thinking_delta") {
          terminal.onThinkingDelta(ev.delta);
        }
        break;
      }

      case "tool_execution_start":
        terminal.onToolStart(event.toolName, event.args);
        break;

      case "tool_execution_update": {
        // 提取工具流式输出的文本
        const text = extractResultText(event.partialResult);
        if (text) terminal.onToolUpdate(text);
        break;
      }

      case "tool_execution_end":
        terminal.onToolEnd(event.toolName, event.isError);
        break;

      case "compaction_start":
        terminal.onCompactionStart();
        break;

      case "auto_retry_start":
        terminal.onRetryStart(event.attempt, event.maxAttempts);
        break;
    }
  });
}

/** 去除 ANSI 转义序列 */
function stripAnsiCodes(s: string): string {
  return s
    .replace(/\x1b\[[0-9;:]*[a-zA-Z]/g, "")
    .replace(/\x1b\][\s\S]*?(?:\x1b\\|\x07|\x1b)/g, "")
    .replace(/\x9b[0-9;:]*[a-zA-Z]/g, "");
}

/** 从 AgentToolResult 中提取全部文本内容 */
function extractResultText(result: any): string {
  if (!result?.content) return "";
  return result.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("");
}

// ─── 自定义工具：Agent 调用它提交结构化的解题思路 ─────────
//     使用 JSON Schema 描述参数，避免对 typebox 的依赖

const listApproachesTool = defineTool({
  name: "list_approaches",
  label: "列出解题思路",
  description: [
    `列出 ${APPROACHES_COUNT} 种数学建模解题思路。`,
    "系统将为每种思路启动一个独立的 coding Agent 并行实现。",
    `请确保刚好提供 ${APPROACHES_COUNT} 个思路，不要多不要少。`,
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      approaches: {
        type: "array",
        description: `${APPROACHES_COUNT} 种解题思路`,
        minItems: APPROACHES_COUNT,
        maxItems: APPROACHES_COUNT,
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "思路名称" },
            description: { type: "string", description: "简短描述" },
          },
          required: ["name", "description"],
        },
      },
    },
    required: ["approaches"],
  },
  execute: async (_toolCallId: string, params: any) => {
    return {
      content: [
        {
          type: "text" as const,
          text: `已确认 ${params.approaches.length} 种思路。`,
        },
      ],
      details: {},
    };
  },
});

// ─── 构建分析 prompt ─────────────────────────────────────────

function buildAnalysisPrompt(): string {
  const parts: string[] = [];

  for (const ctx of contextFiles) {
    if (existsSync(ctx)) {
      const content = readFileSync(ctx, "utf-8").trim();
      if (content) parts.push(`## 前序结果\n\n${content}\n`);
    }
  }

  parts.push(`## 当前问题\n\n${problem}`);
  parts.push(
    `分析以上问题，然后调用 list_approaches 工具列出 ${APPROACHES_COUNT} 种不同的解题思路。`,
    "每种思路在数学建模方法上要有本质差异。",
    "可以引用前序结果作为已知条件，但不要重复解决已解决的问题。",
  );

  return parts.join("\n\n");
}

// ─── 从 session 消息中提取工具调用的思路列表 ────────────────

function extractApproaches(session: any): Approach[] {
  for (const msg of session.messages) {
    if (msg.role !== "assistant") continue;
    for (const block of msg.content) {
      if (block?.type !== "toolCall" || block.name !== "list_approaches")
        continue;
      try {
        const args =
          typeof block.arguments === "string"
            ? JSON.parse(block.arguments)
            : block.arguments;
        if (args.approaches?.length) {
          return args.approaches.map((a: any, i: number) => ({
            index: i,
            name: a.name || `思路 ${i + 1}`,
          }));
        }
      } catch {}
    }
  }
  return [];
}

// ─── 主流程 ──────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log(`  ${Q_NAME}`);
  console.log(`  文件: ${PROBLEM_FILE}`);
  console.log(`  模型: ${MODEL_PROVIDER}/${MODEL_ID}`);
  console.log(`  思路数: ${APPROACHES_COUNT}`);
  if (contextFiles.length > 0) console.log("  前序:", contextFiles.join(", "));
  console.log("=".repeat(60));

  if (existsSync(WORK_BASE)) rmSync(WORK_BASE, { recursive: true });
  ensureDir(WORK_BASE);

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);
  const model = getModel(MODEL_PROVIDER, MODEL_ID);
  if (!model) throw new Error(`模型 ${MODEL_PROVIDER}/${MODEL_ID} 未找到`);

  // ── 1. 分析：通过工具调用获取结构化思路 ─────────────────

  log("分析", "开始...\n");

  const analysisSM = SessionManager.create(Q_DIR);
  const analysis = await createAgentSession({
    sessionManager: analysisSM,
    authStorage,
    modelRegistry,
    model,
    customTools: [listApproachesTool],
  });

  const analysisTerm = new CaptureTerminal(
    join(WORK_BASE, "analysis.log"),
    "分析",
  );
  const unsub = subscribeSession("分析", analysis.session, analysisTerm);
  await analysis.session.prompt(buildAnalysisPrompt());
  unsub();
  analysisTerm.flush();
  console.log("\n");

  let approaches = extractApproaches(analysis.session);

  // 回退：工具调用没拿到就解析文本
  if (approaches.length === 0) {
    const text = lastAssistantText(analysis.session.messages);
    const lines = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^思路\d+[：:]/.test(l));
    approaches = lines.map((l, i) => {
      const m = l.match(/^思路\d+[：:]\s*(.+)/);
      return { index: i, name: m ? m[1].trim() : l };
    });
  }

  if (approaches.length === 0) throw new Error("无法获取解题思路");

  console.log("思路:");
  approaches.forEach((a) => console.log(`  ${a.index + 1}. ${a.name}`));

  // ── 2. Fork ────────────────────────────────────────────

  log("Fork", `分叉 ${approaches.length} 个 Session...`);

  const originalSessionFile = analysisSM.getSessionFile();
  if (!originalSessionFile) throw new Error("session 未持久化");

  const entries = analysisSM.getEntries();
  const problemEntry = entries.find(
    (e): e is { type: "message"; message: { role: string }; id: string } =>
      e.type === "message" && (e as any).message?.role === "user",
  );
  if (!problemEntry) throw new Error("未找到问题消息");

  const codingSessions = await Promise.all(
    approaches.map(async (approach) => {
      const dir = join(WORK_BASE, `approach-${approach.index + 1}`);
      ensureDir(dir);

      const sm = SessionManager.open(originalSessionFile);
      const forkPath = sm.createBranchedSession(problemEntry.id);
      if (!forkPath) throw new Error(`Fork 失败: 思路 ${approach.index + 1}`);

      const forkSM = SessionManager.open(forkPath);

      const contextHint = contextFiles
        .filter((f) => existsSync(f))
        .map(
          (f) => `前序结果参考: ${readFileSync(f, "utf-8").slice(0, 500)}...`,
        )
        .join("\n");

      forkSM.appendMessage({
        role: "user",
        content: [
          {
            type: "text",
            text: [
              `请按「${approach.name}」思路解题。`,
              contextHint,
              `工作目录: ${dir}`,
              "代码必须可独立运行，包含建模、求解、输出。",
              "最终在工作目录下创建 summary.md，说明建模过程、关键公式和结果。",
            ]
              .filter(Boolean)
              .join("\n"),
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

      return { approach, session, dir };
    }),
  );

  // ── 3. 并行编码 ────────────────────────────────────────

  log("编码", `启动 ${codingSessions.length} 个 Agent...\n`);

  const terminals = codingSessions.map(
    (cs) =>
      new CaptureTerminal(
        join(cs.dir, "session.log"),
        `思路 ${cs.approach.index + 1}：${cs.approach.name}`,
      ),
  );

  const unsubs = codingSessions.map((cs, i) =>
    subscribeSession(`思路${cs.approach.index + 1}`, cs.session, terminals[i]),
  );

  const startTime = Date.now();
  const settled = await Promise.allSettled(
    codingSessions.map((cs) => cs.session.prompt("开始编写")),
  );
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  unsubs.forEach((u) => u());
  terminals.forEach((t) => t.flush());

  console.log(`\n[编码] 完成，耗时 ${elapsed}s\n`);

  // ── 4. 收集 ────────────────────────────────────────────

  const results: Result[] = [];

  for (let i = 0; i < codingSessions.length; i++) {
    const cs = codingSessions[i];
    const r = settled[i];

    if (r.status === "rejected") {
      console.log(
        `  \u274c 思路 ${cs.approach.index + 1}「${cs.approach.name}」失败`,
      );
      results.push({
        index: cs.approach.index,
        name: cs.approach.name,
        files: new Map(),
        success: false,
        error: String(r.reason),
      });
    } else {
      const files = collectFiles(cs.dir);
      console.log(
        `  \u2705 思路 ${cs.approach.index + 1}「${cs.approach.name}」: ${files.size} 个文件`,
      );
      results.push({
        index: cs.approach.index,
        name: cs.approach.name,
        files,
        success: true,
      });
    }
    cs.session.dispose();
  }

  // ── 5. 评审（可选） ──────────────────────────────────

  if (SKIP_REVIEW) {
    analysis.session.dispose();
    const sessionDir = analysisSM.getSessionDir();
    if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true });
    console.log("=".repeat(60));
    console.log("  完成（跳过评审）");
    console.log("=".repeat(60));
    return;
  }

  log("评审", "开始...\n");

  const report = [
    "# 题目\n",
    problem,
    contextFiles.filter((f) => existsSync(f)).length > 0
      ? "\n# 前序结果\n" +
        contextFiles.map((f) => readFileSync(f, "utf-8")).join("\n---\n")
      : "",
    "\n# 各思路结果\n",
    ...results.map((r) =>
      [
        `## 思路 ${r.index + 1}：${r.name}`,
        r.error ? `错误: ${r.error}` : "",
        ...Array.from(r.files.entries()).map(
          ([path, content]) =>
            `### ${basename(path)}\n\`\`\`\n${content}\n\`\`\``,
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

  const reviewTerm = new CaptureTerminal(join(WORK_BASE, "review.log"), "评审");
  const unsubReview = subscribeSession("评审", review.session, reviewTerm);
  await review.session.prompt(
    [
      "你是一位 MCM 竞赛评审专家。请审阅以下解题代码。",
      "",
      report,
      "",
      "请输出评审报告：",
      "1. 每个思路的优缺点（建模合理性、代码质量、创新性）",
      "2. 横向对比表格",
      "3. 最终推荐哪个思路，并说明理由",
      "4. 关键数值结果摘要（如果有可量化的结果）",
    ].join("\n"),
  );
  unsubReview();
  reviewTerm.flush();

  const reviewText = lastAssistantText(review.session.messages);
  const reportPath = join(WORK_BASE, "review-report.md");
  writeFileSync(reportPath, reviewText, "utf-8");

  const summaryPath = join(WORK_BASE, "summary.md");
  writeFileSync(summaryPath, reviewText, "utf-8");

  console.log(`\n报告: ${reportPath}`);

  review.session.dispose();
  analysis.session.dispose();

  const sessionDir = analysisSM.getSessionDir();
  if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true });

  console.log("=".repeat(60));
  console.log("  完成");
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("\n错误:", err);
  process.exit(1);
});
