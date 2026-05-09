/**
 * Subprocess runner — spawns pi processes for isolated problem solving.
 * Stderr is forwarded to parent process for live monitoring.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { withFileMutationQueue } from "@mariozechner/pi-coding-agent";
import type { AgentConfig } from "./agents.js";

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface RunnerConfig {
  agent: AgentConfig;
  task: string;
  cwd: string;
  modelOverride?: string;
  additionalSystemPrompt?: string;
  timeoutMs: number;
}

async function writePromptToTempFile(
  agentName: string,
  prompt: string,
): Promise<{ dir: string; filePath: string }> {
  const tmpDir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "mcm-solver-"),
  );
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  await withFileMutationQueue(filePath, async () => {
    await fs.promises.writeFile(filePath, prompt, {
      encoding: "utf-8",
      mode: 0o600,
    });
  });
  return { dir: tmpDir, filePath };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

export function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content) {
        if (part.type === "text") return part.text;
      }
    }
  }
  return "";
}

export async function runSingleAgent(
  config: RunnerConfig,
  signal: AbortSignal | undefined,
  logPrefix?: string,
): Promise<SingleResult> {
  const { agent, task, cwd, modelOverride, additionalSystemPrompt, timeoutMs } =
    config;
  const prefix = logPrefix ?? `[${agent.name}]`;

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const model = modelOverride ?? agent.model;
  if (model) args.push("--model", model);
  if (agent.tools && agent.tools.length > 0)
    args.push("--tools", agent.tools.join(","));

  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agent.name,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model,
  };

  try {
    let systemPrompt = agent.systemPrompt.trim();
    if (additionalSystemPrompt) {
      systemPrompt = `${systemPrompt}\n\n${additionalSystemPrompt}`;
    }
    if (systemPrompt) {
      const tmp = await writePromptToTempFile(agent.name, systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }

    args.push(`Task: ${task}`);
    console.error(
      `${prefix} starting pi subprocess (model=${model}, tools=${agent.tools?.join(",") || "none"})...`,
    );
    let wasAborted = false;
    let timedOut = false;

    const exitCode = await new Promise<number>((resolve) => {
      const invocation = getPiInvocation(args);
      const proc = spawn(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      let timeoutTimer: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        }, timeoutMs);
      }

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          currentResult.messages.push(msg);

          if (msg.role === "assistant") {
            currentResult.usage.turns++;
            const usage = msg.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && msg.model)
              currentResult.model = msg.model;
            if (msg.stopReason) currentResult.stopReason = msg.stopReason;
            if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;

            // Log turn summary to stderr (visible in parent)
            const toolCallCount = msg.content.filter(
              (c: any) => c.type === "tool_call",
            ).length;
            const textLen = msg.content
              .filter((c: any) => c.type === "text")
              .reduce((s: number, c: any) => s + (c.text?.length ?? 0), 0);
            console.error(
              `${prefix} turn ${currentResult.usage.turns}: ${textLen} text chars, ${toolCallCount} tool calls, model=${msg.model || currentResult.model}, cost=$${(usage?.cost?.total ?? 0).toFixed(6)}`,
            );
          }
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          const tr = event.message as any;
          if (tr.toolCallId) {
            const toolName = tr.toolName || tr.name || "?";
            const contentLen = tr.content
              ? tr.content.reduce((s: number, c: any) => s + (c.text?.length ?? 0), 0)
              : 0;
            console.error(prefix + " tool_result: " + toolName + " (" + contentLen + " chars)");
          }
        }

        // Stream thinking deltas (truncate long bursts)
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "thinking_delta") {
          const delta = event.assistantMessageEvent.delta;
          if (delta && delta.length < 80) process.stderr.write(delta);
        }

        // Stream text deltas to terminal
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
          process.stderr.write(event.assistantMessageEvent.delta);
        }

        // Log tool calls with args preview
        if (event.type === "message_update" && event.assistantMessageEvent?.type === "tool_call") {
          const tc = event.assistantMessageEvent;
          const argsPreview = JSON.stringify(tc.args || {}).slice(0, 150);
          console.error(prefix + " tool_call: " + (tc.toolName || tc.name) + "(" + argsPreview + ")");
        }

      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      // Forward stderr in real-time so the user sees progress
      proc.stderr.on("data", (data) => {
        const text = data.toString();
        currentResult.stderr += text;
        process.stderr.write(text);
      });

      proc.on("close", (code) => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Solver subprocess was aborted");
    if (timedOut) currentResult.errorMessage = `Timed out after ${timeoutMs}ms`;

    console.error(
      `${prefix} finished: exit=${exitCode}, turns=${currentResult.usage.turns}, cost=$${currentResult.usage.cost.toFixed(6)}`,
    );
    return currentResult;
  } finally {
    if (tmpPromptPath)
      try {
        fs.unlinkSync(tmpPromptPath);
      } catch {
        /* ignore */
      }
    if (tmpPromptDir)
      try {
        fs.rmdirSync(tmpPromptDir);
      } catch {
        /* ignore */
      }
  }
}
