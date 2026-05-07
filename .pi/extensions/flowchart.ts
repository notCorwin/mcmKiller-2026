/**
 * Flowchart Extension
 *
 * - Registers a `draw_flowchart` tool that generates publication-ready SVG
 *   flowcharts from a structured node/edge description.
 * - Academic styling: clean sans-serif, gray palette, 1pt line width.
 * - Automatically opens the result in the default browser.
 * - Optionally converts to PDF via rsvg-convert or inkscape.
 */

import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const NODE_MIN_W = 120;
const NODE_H = 44;
const NODE_GAP_X = 60;
const NODE_GAP_Y = 60;
const PADDING = 40;
const FONT_SIZE = 13;
const LINE_COLOR = "#555555";
const FILL_COLOR = "#ffffff";
const STROKE_COLOR = "#333333";
const STROKE_WIDTH = 1.2;

type Shape = "rect" | "rounded" | "diamond" | "oval";

interface FlowNode {
  id: string;
  text: string;
  shape: Shape;
  row: number;
  col: number;
  w: number;
  h: number;
  x: number;
  y: number;
}

interface FlowEdge {
  from: string;
  to: string;
  label: string;
}

// ---------------------------------------------------------------------------
// Bounding-box helpers
// ---------------------------------------------------------------------------

function centerX(n: FlowNode): number {
  return n.x + n.w / 2;
}
function centerY(n: FlowNode): number {
  return n.y + n.h / 2;
}

function shapePath(
  shape: Shape,
  x: number,
  y: number,
  w: number,
  h: number,
): string {
  switch (shape) {
    case "rounded":
      const r = 8;
      return (
        `M ${x + r} ${y} ` +
        `L ${x + w - r} ${y} ` +
        `Q ${x + w} ${y} ${x + w} ${y + r} ` +
        `L ${x + w} ${y + h - r} ` +
        `Q ${x + w} ${y + h} ${x + w - r} ${y + h} ` +
        `L ${x + r} ${y + h} ` +
        `Q ${x} ${y + h} ${x} ${y + h - r} ` +
        `L ${x} ${y + r} ` +
        `Q ${x} ${y} ${x + r} ${y} Z`
      );
    case "diamond":
      const cx = x + w / 2;
      const cy = y + h / 2;
      return `M ${cx} ${y} L ${x + w} ${cy} L ${cx} ${y + h} L ${x} ${cy} Z`;
    case "oval":
      // Use rx/ry via ellipse; this is a fallback path placeholder
      return "";
    default:
      return `M ${x} ${y} L ${x + w} ${y} L ${x + w} ${y + h} L ${x} ${y + h} Z`;
  }
}

function measureText(text: string): number {
  // Rough estimate: ~8px per char + 40px padding
  return Math.max(NODE_MIN_W, text.length * 8 + 40);
}

// ---------------------------------------------------------------------------
// Layout engine – simple layered grid
// ---------------------------------------------------------------------------

function layout(
  nodes: { id: string; text: string; shape: Shape }[],
  edges: { from: string; to: string; label: string }[],
): FlowNode[] {
  const nodeMap = new Map<string, { id: string; text: string; shape: Shape }>();
  for (const n of nodes) nodeMap.set(n.id, n);

  // 1. Topological sort / assign ranks via longest-path
  const inEdges = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    inEdges.set(n.id, 0);
    children.set(n.id, []);
  }
  for (const e of edges) {
    inEdges.set(e.to, (inEdges.get(e.to) ?? 0) + 1);
    children.get(e.from)?.push(e.to);
  }

  const rank = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((inEdges.get(n.id) ?? 0) === 0) {
      rank.set(n.id, 0);
      queue.push(n.id);
    }
  }
  while (queue.length > 0) {
    const id = queue.shift()!;
    const r = rank.get(id) ?? 0;
    for (const child of children.get(id) ?? []) {
      const nr = rank.get(child) ?? 0;
      if (nr < r + 1) {
        rank.set(child, r + 1);
      }
      const ie = (inEdges.get(child) ?? 1) - 1;
      inEdges.set(child, ie);
      if (ie <= 0) queue.push(child);
    }
  }

  // 2. Group by rank, assign columns
  const byRank = new Map<
    number,
    { id: string; text: string; shape: Shape; w: number }[]
  >();
  for (const n of nodes) {
    const r = rank.get(n.id) ?? 0;
    const w = measureText(n.text);
    if (!byRank.has(r)) byRank.set(r, []);
    byRank.get(r)!.push({ ...n, w });
  }

  // 3. Compute absolute positions (centered per rank)
  const maxCols = Math.max(
    ...Array.from(byRank.values()).map((g) => g.length),
    1,
  );
  const result: FlowNode[] = [];

  for (const [r, group] of byRank) {
    const totalW =
      group.reduce((s, g) => s + g.w, 0) + (group.length - 1) * NODE_GAP_X;
    let xOff =
      PADDING +
      (maxCols * NODE_MIN_W + (maxCols - 1) * NODE_GAP_X - totalW) / 2;

    const yOff = PADDING + r * (NODE_H + NODE_GAP_Y);

    for (const g of group) {
      result.push({
        id: g.id,
        text: g.text,
        shape: g.shape,
        row: r,
        col: 0,
        w: g.w,
        h: NODE_H,
        x: xOff,
        y: yOff,
      });
      xOff += g.w + NODE_GAP_X;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// SVG generation
// ---------------------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function svgArrowHead(id: string): string {
  return `<marker id="arrow-${id}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
    <path d="M 0 0 L 10 5 L 0 10 Z" fill="${LINE_COLOR}" />
  </marker>`;
}

function generateSvg(
  nodes: FlowNode[],
  edges: FlowEdge[],
  nodeDefs: Map<string, { text: string; shape: Shape }>,
): string {
  const nodeMap = new Map<string, FlowNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const maxX = Math.max(...nodes.map((n) => n.x + n.w)) + PADDING;
  const maxY = Math.max(...nodes.map((n) => n.y + n.h)) + PADDING;

  const uniqueId = `flow-${Date.now()}`;
  const lines: string[] = [];

  lines.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${maxX}" height="${maxY}" viewBox="0 0 ${maxX} ${maxY}">`,
  );
  lines.push(`<defs>${svgArrowHead(uniqueId)}</defs>`);

  // Edges (behind nodes)
  for (const e of edges) {
    const src = nodeMap.get(e.from);
    const dst = nodeMap.get(e.to);
    if (!src || !dst) continue;

    const x1 = centerX(src);
    const y1 = src.y + src.h;
    const x2 = centerX(dst);
    const y2 = dst.y;

    // Orthogonal routing: vertical line with bend
    const midY = (y1 + y2) / 2;
    const d = `M ${x1} ${y1} L ${x1} ${midY} L ${x2} ${midY} L ${x2} ${y2 - 6}`;

    lines.push(
      `<path d="${d}" fill="none" stroke="${LINE_COLOR}" stroke-width="${STROKE_WIDTH}" marker-end="url(#arrow-${uniqueId})" />`,
    );

    if (e.label) {
      const lx = (x1 + x2) / 2;
      const ly = midY - 6;
      lines.push(
        `<text x="${lx}" y="${ly}" text-anchor="middle" font-family="sans-serif" font-size="${FONT_SIZE - 2}" fill="${LINE_COLOR}">${escapeXml(e.label)}</text>`,
      );
    }
  }

  // Nodes
  for (const n of nodes) {
    const def = nodeDefs.get(n.id);
    const shape = def?.shape ?? "rect";
    const text = def?.text ?? n.id;

    if (shape === "oval") {
      lines.push(
        `<ellipse cx="${centerX(n)}" cy="${centerY(n)}" rx="${n.w / 2}" ry="${n.h / 2}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" />`,
      );
    } else {
      lines.push(
        `<path d="${shapePath(shape, n.x, n.y, n.w, n.h)}" fill="${FILL_COLOR}" stroke="${STROKE_COLOR}" stroke-width="${STROKE_WIDTH}" />`,
      );
    }

    // Multi-line text support (max 2 lines)
    const words = text.split(/\s+/);
    const lines_ =
      words.length <= 6
        ? [text]
        : [
            words.slice(0, Math.ceil(words.length / 2)).join(" "),
            words.slice(Math.ceil(words.length / 2)).join(" "),
          ];

    if (lines_.length === 1) {
      lines.push(
        `<text x="${centerX(n)}" y="${centerY(n) + FONT_SIZE / 2 - 2}" text-anchor="middle" font-family="sans-serif" font-size="${FONT_SIZE}" fill="${STROKE_COLOR}">${escapeXml(lines_[0])}</text>`,
      );
    } else {
      const lineH = FONT_SIZE + 2;
      const startY =
        centerY(n) - ((lines_.length - 1) * lineH) / 2 + FONT_SIZE / 2 - 2;
      for (let i = 0; i < lines_.length; i++) {
        lines.push(
          `<text x="${centerX(n)}" y="${startY + i * lineH}" text-anchor="middle" font-family="sans-serif" font-size="${FONT_SIZE}" fill="${STROKE_COLOR}">${escapeXml(lines_[i])}</text>`,
        );
      }
    }
  }

  lines.push("</svg>");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

function trimExtension(p: string): string {
  return p.replace(/\.\w+$/, "");
}

/** Write a text file by piping through python3 (avoids shell quoting issues). */
async function writeTextFile(
  pi: ExtensionAPI,
  absPath: string,
  content: string,
  cwd: string,
): Promise<void> {
  // Ensure parent directory exists
  const dir = absPath.substring(0, absPath.lastIndexOf("/"));
  await pi.exec("mkdir", ["-p", dir], { cwd }).catch(() => {});

  // Use python3 with base64 to avoid any quoting issues
  const b64 = Buffer.from(content, "utf-8").toString("base64");
  await pi.exec(
    "python3",
    [
      "-c",
      `import sys,base64; open(sys.argv[1],'wb').write(base64.b64decode(sys.argv[2]))`,
      absPath,
      b64,
    ],
    { cwd },
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "draw_flowchart",
      label: "Draw flowchart",
      description:
        "Generate a publication-ready SVG flowchart from a structured node/edge description. " +
        "Opens the result in the browser and returns the file path. " +
        "Use this instead of hand-writing SVG for paper diagrams.",
      promptSnippet: "Draw publication-ready flowcharts as SVG",
      promptGuidelines: [
        "Use draw_flowchart to create figures for papers instead of writing raw SVG",
        "Describe the flowchart structure (nodes and edges) clearly",
        "Keep node text concise (one or two short lines)",
      ],
      parameters: Type.Object({
        nodes: Type.Array(
          Type.Object({
            id: Type.String({ description: "Unique identifier for this node" }),
            text: Type.String({ description: "Display text (keep concise)" }),
            shape: Type.Enum(
              {
                rect: "rect",
                rounded: "rounded",
                diamond: "diamond",
                oval: "oval",
              } as const,
              {
                description: "Visual shape of the node",
                default: "rounded",
              },
            ),
          }),
          { minItems: 1, description: "Nodes in the flowchart" },
        ),
        edges: Type.Array(
          Type.Object({
            from: Type.String({ description: "Source node id" }),
            to: Type.String({ description: "Target node id" }),
            label: Type.String({
              description: "Edge label (leave empty for none)",
              default: "",
            }),
          }),
          { description: "Directed edges connecting nodes" },
        ),
        output: Type.String({
          description:
            "Output file path (relative or absolute). Defaults to flowchart.svg",
          default: "flowchart.svg",
        }),
        convertPdf: Type.Boolean({
          description:
            "Also convert to PDF via rsvg-convert or inkscape (must be installed)",
          default: false,
        }),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const nodeDefs = new Map<string, { text: string; shape: Shape }>();
        for (const n of params.nodes) {
          nodeDefs.set(n.id, {
            text: n.text,
            shape: (n.shape as Shape) ?? "rounded",
          });
        }

        const edges: FlowEdge[] = (params.edges ?? []).map((e) => ({
          from: e.from,
          to: e.to,
          label: e.label ?? "",
        }));

        const nodes: { id: string; text: string; shape: Shape }[] =
          params.nodes.map((n) => ({
            id: n.id,
            text: n.text,
            shape: (n.shape as Shape) ?? "rounded",
          }));

        const placed = layout(nodes, edges);
        const svg = generateSvg(placed, edges, nodeDefs);

        const outputPath = params.output || "flowchart.svg";
        const absSvgPath = outputPath.startsWith("/")
          ? outputPath
          : `${ctx.cwd}/${outputPath}`;

        // Write SVG
        await writeTextFile(pi, absSvgPath, svg, ctx.cwd);

        // Preview in browser
        await pi.exec("open", [absSvgPath]).catch(() => {});

        // Optional PDF
        let pdfPath: string | undefined;
        if (params.convertPdf) {
          const base = trimExtension(absSvgPath);
          pdfPath = `${base}.pdf`;

          // Try rsvg-convert first, fallback to inkscape
          const rsvg = await pi
            .exec("which", ["rsvg-convert"])
            .catch(() => ({ code: 1 }) as any);
          if (rsvg.code === 0) {
            await pi.exec("rsvg-convert", [
              "-f",
              "pdf",
              "-o",
              pdfPath,
              absSvgPath,
            ]);
          } else {
            const ink = await pi
              .exec("which", ["inkscape"])
              .catch(() => ({ code: 1 }) as any);
            if (ink.code === 0) {
              await pi.exec("inkscape", [
                absSvgPath,
                "--export-filename",
                pdfPath,
              ]);
            }
          }
        }

        const msg = pdfPath
          ? `Flowchart generated: ${outputPath} (PDF: ${pdfPath})`
          : `Flowchart generated: ${outputPath}`;

        return {
          content: [{ type: "text" as const, text: msg }],
          details: { svgPath: absSvgPath, pdfPath },
        };
      },
    }),
  );
}
