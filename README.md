# Pic2svg MCP server and Node client

Turn a local raster image into SVG filled paths through the [Pic2svg](https://pic2svg.com/) HTTP API. This repository contains a dependency-free Node client, command-line tool and stdio Model Context Protocol server. It is useful for tracing logos, icons and flat illustrations in scripts or agent workflows.

The client runs locally; tracing runs on Pic2svg's server. **Your input image is uploaded.** This is deterministic vector tracing, not generative image creation, an offline tracer or a hosted-service source release. Output is SVG, not centerline cutting instructions or a guarantee of machine-ready geometry.

## Install from source

Requirements: Node.js 20 or later and Git, or download this repository's ZIP. No dependency installation is needed. Tests and live conversion were checked with Node 24.22.1; Node 20 is the declared minimum, not a separately tested runtime in this release.

```sh
git clone https://github.com/szj2ys/pic2svg-mcp.git
cd pic2svg-mcp
node --test
node ./pic2svg-mcp.mjs trace ./logo.png --preset compact --out ./logo-traced.svg
```

Replace `./logo.png` with your own image. The npm registry returned 404 for `pic2svg-mcp` on 2026-10-27. Use this source installation; `npx pic2svg-mcp` is not a verified installation path.

Without `--out`, the CLI writes `<input-name>.pic2svg.svg` beside the input. **An existing output file is overwritten**, including an explicitly selected output path. Choose a new destination and keep it different from your input. The client reads the complete image into memory and has no explicit request timeout.

## Use with an MCP client

Add a stdio server using the absolute path to the downloaded source. Configuration file location and reload behavior depend on your MCP client.

```json
{
  "mcpServers": {
    "pic2svg": {
      "command": "node",
      "args": ["/absolute/path/to/pic2svg-mcp/pic2svg-mcp.mjs"]
    }
  }
}
```

On Windows, use escaped backslashes or forward slashes in the JSON path. If your MCP host cannot resolve `node`, supply its absolute executable path.

The `trace_image_to_svg` tool accepts:

| Argument | Meaning |
| --- | --- |
| `path` | Required local input image path. |
| `preset` | `balanced` (default), `compact`, or `sharp`. |
| `output_path` | Optional output SVG destination; an existing file can be overwritten. |
| `include_svg` | Also return the SVG text in the tool response; default `false`. |

The server implements newline-delimited JSON-RPC over stdio, initialization, tool discovery and tool calls. The included tests exercise those behaviors against a local fixture server; they do not certify every third-party MCP application. Tell the image owner that the image will leave the machine before uploading private material.

## Use from Node

```js
import { imageFromPath, trace } from './client.mjs';
import { writeFile } from 'node:fs/promises';

const input = await imageFromPath('./logo.png');
const result = await trace({ ...input, preset: 'compact' });
await writeFile('./logo-traced.svg', result.svgText);
console.log(result.canvas, result.sizeKB, result.remaining);
```

## Public HTTP API

**Authentication:** no API key or account is required for this endpoint. Use HTTPS:

```text
POST https://api.pic2svg.com/api/v1/trace
Content-Type: application/json
```

Request fields:

```json
{
  "imageBase64": "data:image/png;base64,<your-image-bytes>",
  "fileName": "logo.png",
  "preset": "balanced"
}
```

`imageBase64` is required and accepts a data URL or raw base64. `fileName` and `preset` are optional. The accepted preset names are `balanced`, `compact` and `sharp`. PNG, JPG, WebP, GIF, BMP and TIFF inputs are supported. Large traces are reduced to approximately 600,000 pixels; transparent areas become white background shapes.

A successful response is JSON with `svgText` (SVG markup), `mode` (trace mode), `canvas` (`w`, `h`, `paths`) and `sizeKB`. The Node client additionally exposes `remaining` from `X-RateLimit-Remaining`, or `null` if the header is absent. The API provides SVG only; the website's other export formats and plans are separate.

The service has a free daily allowance. Source defaults are 50 traces per client and 500 globally per UTC day; deployment configuration can change these and availability is not guaranteed. Observe the response headers `X-RateLimit-Limit` and `X-RateLimit-Remaining` where present. Quotas are best-effort process-memory counters and may reset on restart. A refused conversion may still consume allowance.

| Response | Meaning |
| --- | --- |
| `400` | Missing image, invalid preset or a refused input. |
| `413` | Payload too large; base64 is limited to 60,000,000 characters, approximately 45 MB of image bytes. Earlier infrastructure limits may also apply. |
| `429` | Daily allowance exhausted; respect `Retry-After`. |
| `500` | Tracing failed. |

**CORS:** an OPTIONS preflight on 2026-10-27 from `https://example.com`, requesting POST with `content-type`, returned 200 without `Access-Control-Allow-*` headers. That origin did not receive permission for a direct browser JSON request. Use Node/server/CLI requests; do not assume arbitrary browser cross-origin access. This observation does not establish behavior for every origin.

`PIC2SVG_API_URL` optionally changes the receiving API base URL. Set it only when you intend to send the image to another compatible deployment. No API key is added by this client.

## Privacy and limitations

Images are sent to the selected remote API, not processed offline. The normal Pic2svg trace implementation uses its own vector-tracing engine rather than a third-party generative AI service. This repository makes no additional image-retention guarantee; consult the service's [privacy policy](https://pic2svg.com/privacy) before sensitive uploads.

Filled paths can overlap and are not centerlines. Inspect the output in your design or cutting software. The [SVG cut-file checker](https://pic2svg.com/svg-cut-file-checker/) can help inspect SVG structure before further manual preparation.

## Development and license

`node --test` runs the client and stdio/CLI tests with a local fixture API. It does not send test images to production. `node scripts/check-release.mjs` checks npm packaging metadata with a dry run; a passing check is not proof that a package has been published.

The client code is under the [MIT license](LICENSE), preserving the existing copyright notice. The hosted Pic2svg service and its backend are separate; this license does not grant rights to that service's private implementation or override its terms.
