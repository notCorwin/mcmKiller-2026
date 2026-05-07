/**
 * TeX Live Extension
 *
 * - Registers a `compile_latex` tool so the AI compiles .tex files via latexmk
 *   instead of guessing shell commands.
 * - Auto-compiles .tex files after write/edit tool executions.
 * - Discovers .tex files in the workspace via resources_discover.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

interface CompileResult {
  success: boolean;
  file: string;
  log: string;
  errors: string[];
}

async function compileLatex(
  pi: ExtensionAPI,
  file: string,
  cwd: string,
): Promise<CompileResult> {
  const result = await pi.exec(
    "latexmk",
    ["-lualatex", "-interaction=nonstopmode", "-file-line-error", file],
    { cwd },
  );

  const combined = `${result.stdout}\n${result.stderr}`;
  const lines = combined.split("\n");

  // Collect error lines (both !-style and file:line:error from -file-line-error)
  const errors: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("!") || /^[^\s:]+:\d+:/.test(trimmed)) {
      errors.push(trimmed);
    }
  }

  return {
    success: result.code === 0 || errors.length === 0,
    file,
    log: combined,
    errors,
  };
}

export default function (pi: ExtensionAPI) {
  // ---- State ----
  let autoCompileEnabled = true;
  const pendingCompiles = new Map<string, string>();

  // ---- Compile tool ----
  pi.registerTool(
    defineTool({
      name: "compile_latex",
      label: "Compile LaTeX",
      description:
        "Compile a .tex file using LuaLaTeX (via latexmk). Use this instead of running latexmk or lualatex manually in bash.",
      promptSnippet: "Compile .tex files with latexmk",
      promptGuidelines: [
        "After editing a .tex file, call compile_latex to verify it compiles without errors",
        "Use compile_latex instead of running latexmk or lualatex in bash",
      ],
      parameters: Type.Object({
        file: Type.String({
          description:
            "Path to the .tex file to compile (relative or absolute)",
        }),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = await compileLatex(pi, params.file, ctx.cwd);

        if (result.success) {
          const pdfFile = params.file.replace(/\.tex$/, ".pdf");
          return {
            content: [
              {
                type: "text" as const,
                text: `Compilation successful: ${pdfFile}`,
              },
            ],
            details: result,
          };
        }

        const errorText = result.errors.slice(0, 30).join("\n");
        const tail =
          result.errors.length > 30
            ? `\n... and ${result.errors.length - 30} more errors`
            : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `Compilation failed with ${result.errors.length} error(s):\n${errorText}${tail}`,
            },
          ],
          details: result,
        };
      },
    }),
  );

  // ---- Toggle command ----
  pi.registerCommand("texlive_autocompile", {
    description: "Toggle automatic compilation on .tex file edits",
    handler: async (_args, ctx) => {
      autoCompileEnabled = !autoCompileEnabled;
      const msg = autoCompileEnabled
        ? "Auto-compile enabled"
        : "Auto-compile disabled";
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      }
    },
  });

  // ---- Auto-compile on write/edit ----
  pi.on("tool_execution_start", (event) => {
    if (!autoCompileEnabled) return;
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const path: unknown = (event.args as Record<string, unknown>)?.path;
    if (typeof path !== "string" || !path.endsWith(".tex")) return;

    pendingCompiles.set(event.toolCallId, path);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    if (!autoCompileEnabled) return;
    if (event.isError) return;

    const path = pendingCompiles.get(event.toolCallId);
    if (!path) return;

    pendingCompiles.delete(event.toolCallId);

    // Fire-and-forget: don't block the agent turn
    compileLatex(pi, path, ctx.cwd).then((result) => {
      if (!ctx.hasUI) return;
      if (result.success) {
        const pdfFile = path.replace(/\.tex$/, ".pdf");
        ctx.ui.notify(`Compiled: ${pdfFile}`, "info");
      } else {
        const summary = result.errors.slice(0, 3).join("; ");
        ctx.ui.notify(
          `Compile failed (${result.errors.length} errors): ${summary}`,
          "error",
        );
      }
    });
  });
}
