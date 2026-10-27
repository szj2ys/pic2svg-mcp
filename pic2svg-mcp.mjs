#!/usr/bin/env node
/**
 * pic2svg for AI agents and the command line.
 *
 *   pic2svg-mcp                         MCP server on stdio (for Claude, Cursor, ...)
 *   pic2svg-mcp trace <image> [--preset balanced|sharp|compact] [--out file.svg]
 *
 * One tool, `trace_image_to_svg`: it uploads a local image to pic2svg's
 * public trace API (see ./client.mjs) and writes the SVG next to it. The API
 * has its own daily allowance, separate from the website's free pool.
 * The image leaves the machine — it is traced on pic2svg's server, like any
 * upload from pic2svg.com — and the tool says so in its description, so an
 * agent can tell its user before sending a file.
 *
 * No dependencies: MCP over stdio is newline-delimited JSON-RPC 2.0, and the
 * three requests a tools-only server must answer (initialize, tools/list,
 * tools/call) fit in this file.
 */

import { realpathSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, extname, basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { PRESETS, apiBase, imageFromPath, trace } from "./client.mjs";

export const SERVER_INFO = { name: "pic2svg", version: "0.1.0" };
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const TOOL = {
  name: "trace_image_to_svg",
  title: "Trace an image to SVG with pic2svg",
  description:
    "Trace a raster image (PNG, JPG, WebP, GIF, BMP or TIFF) on the local disk into a real vector SVG of filled paths, using pic2svg's deterministic vtracer-based engine. The image is uploaded to pic2svg's server (api.pic2svg.com) to be traced and is not sent to any third-party AI service. Transparency becomes a white background shape; traces run at up to about 600,000 pixels. The API has a daily allowance per client; when it is spent the tool says so. Writes the SVG to disk and returns its path, trace mode, path count and size.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path of the image file to trace." },
      preset: {
        type: "string",
        enum: PRESETS,
        default: "balanced",
        description: "Balanced (default) suits most images; compact merges near-identical colours for fewer shapes; sharp keeps the most detail.",
      },
      output_path: {
        type: "string",
        description: "Where to write the SVG. Default: next to the image, as <name>.pic2svg.svg.",
      },
      include_svg: {
        type: "boolean",
        default: false,
        description: "Also return the SVG text itself. Traces can be hundreds of KB, so leave this off unless the SVG is needed in the conversation.",
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
};

/** Default output: beside the input, never over a file named <name>.svg. */
export function defaultOutput(input) {
  const stem = basename(input, extname(input));
  return join(dirname(input), `${stem}.pic2svg.svg`);
}

export async function runTrace(args, deps = {}) {
  if (!args || typeof args.path !== "string" || !args.path) throw new Error("`path` is required");
  const preset = args.preset ?? "balanced";
  const image = await imageFromPath(args.path);
  const result = await trace({ ...image, preset }, { api: deps.api ?? apiBase(), fetchImpl: deps.fetchImpl });
  const out = args.output_path || defaultOutput(args.path);
  await writeFile(out, result.svgText, "utf8");
  const left = result.remaining === null || result.remaining === undefined ? "" : ` ${result.remaining} traces left today.`;
  const summary = `Traced ${image.fileName} on the ${preset} preset: ${result.canvas.paths} filled paths in ${result.mode} mode on a ${result.canvas.w} x ${result.canvas.h} canvas, ${result.sizeKB} KB. SVG written to ${out}.${left}`;
  return { summary, out, result };
}

/** Handle one JSON-RPC message; returns the response, or undefined for a notification. */
export async function handle(message, deps = {}) {
  const { id, method, params } = message;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const error = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  if (id === undefined || id === null) return undefined; // notifications need no answer
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Use trace_image_to_svg to turn a local raster image into an editable SVG. It uploads the image to pic2svg's server; tell the user before sending private files.",
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: [TOOL] });
    case "tools/call": {
      if (params?.name !== TOOL.name) return error(-32602, `unknown tool: ${params?.name}`);
      try {
        const { summary, result } = await runTrace(params.arguments ?? {}, deps);
        const content = [{ type: "text", text: summary }];
        if (params.arguments?.include_svg) content.push({ type: "text", text: result.svgText });
        return reply({ content, isError: false });
      } catch (err) {
        // Tool failures are results the model can read, not protocol errors.
        return reply({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true });
      }
    }
    default:
      return error(-32601, `method not found: ${method}`);
  }
}

function serve() {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
      return;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

async function cli(argv) {
  const [, file, ...rest] = argv;
  if (!file) {
    console.error("usage: pic2svg-mcp trace <image> [--preset balanced|sharp|compact] [--out file.svg]");
    process.exit(2);
  }
  const flag = (name) => {
    const i = rest.indexOf(name);
    return i === -1 ? undefined : rest[i + 1];
  };
  try {
    const { summary } = await runTrace({ path: file, preset: flag("--preset"), output_path: flag("--out") });
    console.log(summary);
  } catch (err) {
    console.error(String(err?.message ?? err));
    process.exit(1);
  }
}

/** True when this file is the program being run (directly or via an npm bin link). */
function isEntry() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  if (process.argv[2] === "trace") await cli(process.argv.slice(2));
  else serve();
}
