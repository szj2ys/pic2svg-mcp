/**
 * The MCP server end to end, against a local fake of pic2svg's trace
 * operation: a real child process speaking JSON-RPC over stdio, a real HTTP
 * request, a real file written. Never contacts pic2svg.com.
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultOutput } from "./pic2svg-mcp.mjs";

const SERVER = fileURLToPath(new URL("./pic2svg-mcp.mjs", import.meta.url));
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0H2V2Z" fill="#000000"/></svg>';
const dir = mkdtempSync(join(tmpdir(), "pic2svg-mcp-"));
const image = join(dir, "logo.png");
writeFileSync(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));

let api;
let requests = [];
let reply = () => ({
  status: 200,
  headers: { "x-ratelimit-limit": "50", "x-ratelimit-remaining": "49" },
  body: { svgText: SVG, mode: "polygon", canvas: { w: 2, h: 2, paths: 1 }, sizeKB: 0.1 },
});

before(async () => {
  api = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, type: req.headers["content-type"], ua: req.headers["user-agent"], body: JSON.parse(body) });
      const { status, body: out, headers = {} } = reply();
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
});
after(() => api.close());

function startServer() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PIC2SVG_API_URL: `http://127.0.0.1:${api.address().port}` },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines = createInterface({ input: child.stdout });
  const waiting = new Map();
  lines.on("line", (line) => {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  });
  let id = 0;
  return {
    call(method, params) {
      const n = ++id;
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`);
      return new Promise((r) => waiting.set(n, r));
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
    stop: () => child.kill(),
  };
}

test("handshake, tool listing and a trace written beside the image", async () => {
  requests = [];
  const s = startServer();
  try {
    const init = await s.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    assert.equal(init.result.protocolVersion, "2025-06-18");
    assert.deepEqual(init.result.capabilities.tools, { listChanged: false });
    s.notify("notifications/initialized");

    const list = await s.call("tools/list", {});
    assert.equal(list.result.tools.length, 1);
    assert.equal(list.result.tools[0].name, "trace_image_to_svg");
    assert.match(list.result.tools[0].description, /uploaded to pic2svg's server/);

    const call = await s.call("tools/call", { name: "trace_image_to_svg", arguments: { path: image, preset: "compact" } });
    assert.equal(call.result.isError, false);
    assert.match(call.result.content[0].text, /1 filled paths in polygon mode/);
    assert.match(call.result.content[0].text, /49 traces left today/);
    assert.equal(call.result.content.length, 1, "SVG text is only returned when asked for");

    // The request goes to the public API, never the website's own action.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/v1/trace");
    assert.equal(requests[0].type, "application/json");
    assert.match(requests[0].ua, /^pic2svg-mcp\/\d+\.\d+\.\d+/);
    assert.equal(requests[0].body.preset, "compact");
    assert.equal(requests[0].body.fileName, "logo.png");
    assert.match(requests[0].body.imageBase64, /^data:image\/png;base64,/);

    const out = defaultOutput(image);
    assert.ok(out.endsWith("logo.pic2svg.svg"));
    assert.equal(readFileSync(out, "utf8"), SVG);
  } finally {
    s.stop();
  }
});

test("returns the SVG text when asked and honours output_path", async () => {
  const s = startServer();
  try {
    const target = join(dir, "custom.svg");
    const call = await s.call("tools/call", { name: "trace_image_to_svg", arguments: { path: image, output_path: target, include_svg: true } });
    assert.equal(call.result.content[1].text, SVG);
    assert.ok(existsSync(target));
  } finally {
    s.stop();
  }
});

test("passes the server's own message through as a tool error", async () => {
  reply = () => ({
    status: 429,
    headers: { "retry-after": "3600" },
    body: { message: "This client has used its daily pic2svg trace API allowance." },
  });
  const s = startServer();
  try {
    const call = await s.call("tools/call", { name: "trace_image_to_svg", arguments: { path: image } });
    assert.equal(call.result.isError, true);
    assert.match(call.result.content[0].text, /429: This client has used its daily pic2svg trace API allowance\. \(retry after 60 min\)/);
  } finally {
    s.stop();
  }
});

test("rejects unknown tools, missing files and bad presets", async () => {
  const s = startServer();
  try {
    const unknown = await s.call("tools/call", { name: "nope", arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const missing = await s.call("tools/call", { name: "trace_image_to_svg", arguments: { path: join(dir, "absent.png") } });
    assert.equal(missing.result.isError, true);
    const preset = await s.call("tools/call", { name: "trace_image_to_svg", arguments: { path: image, preset: "huge" } });
    assert.match(preset.result.content[0].text, /preset must be one of/);
    const method = await s.call("resources/list", {});
    assert.equal(method.error.code, -32601);
  } finally {
    s.stop();
  }
});
