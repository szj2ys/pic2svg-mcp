/**
 * The one call this package makes: pic2svg's public trace API.
 *
 *   POST {api}/api/v1/trace
 *   { "imageBase64": "data:image/png;base64,...", "fileName": "logo.png", "preset": "balanced" }
 *   -> 200 { "svgText": "<svg ...>", "mode": "polygon", "canvas": { "w", "h", "paths" }, "sizeKB" }
 *
 * The endpoint runs the same engine as the website's converter, but it has
 * its own daily allowance (src/convert/apiQuota.ts on the server: per client
 * and for all API callers together), separate from the website's anonymous
 * pool. When an allowance is spent the server answers 429 with a message and
 * a Retry-After header; both are passed on in the error.
 *
 * Unlike the website, this sends the image file as it is: there is no browser
 * here to scale it and re-encode it (as a PNG for flat art, a JPEG for
 * photos). The server still caps every
 * trace at about 600,000 pixels and refuses requests over about 45 MB.
 */

import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";

const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
/** Lets the server count calls from this package; npm always ships package.json. */
export const USER_AGENT = `pic2svg-mcp/${version}`;

export const DEFAULT_API = "https://api.pic2svg.com";
export const TRACE_PATH = "/api/v1/trace";
export const PRESETS = ["sharp", "balanced", "compact"];
/** The server refuses a base64 payload longer than this. */
export const MAX_BASE64_CHARS = 60_000_000;

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

export function apiBase(env = process.env) {
  return (env.PIC2SVG_API_URL || DEFAULT_API).replace(/\/+$/, "");
}

/** Read a local image into the data URL the API expects. */
export async function imageFromPath(path) {
  const bytes = await readFile(path);
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return { fileName: basename(path), imageBase64: `data:${mime};base64,${bytes.toString("base64")}` };
}

/** The API address as it may be printed: never with credentials in it. */
function printable(api) {
  try {
    const url = new URL(api);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return api.replace(/\/\/[^/@]*@/, "//");
  }
}

/**
 * Node's fetch rejects with a bare "fetch failed"; what went wrong is on
 * err.cause (a code such as ECONNREFUSED, ENOTFOUND or
 * UND_ERR_CONNECT_TIMEOUT, sometimes inside an AggregateError). Say where it
 * tried and why, so an agent or a person knows what to fix. Anything that is
 * not a fetch failure (a bug in a caller's fetchImpl) is returned unchanged.
 */
function describeFetchFailure(err, api) {
  if (!(err instanceof TypeError)) return err;
  const cause = err.cause;
  const code = cause?.code ?? cause?.errors?.find?.((e) => e?.code)?.code;
  const where = printable(api);
  if (code === "ERR_INVALID_URL" || /Invalid URL|Failed to parse URL/i.test(err.message)) {
    return new Error(`the pic2svg API address is not a valid URL: ${where}. Check PIC2SVG_API_URL.`, { cause: err });
  }
  if (/credentials/i.test(err.message)) {
    return new Error(`the pic2svg API address must not contain a user name or password: ${where}. Check PIC2SVG_API_URL.`, { cause: err });
  }
  if (!code && err.message !== "fetch failed") return err;
  return new Error(
    `could not reach pic2svg at ${where} (${code ?? cause?.message ?? "network error"}). Check the network connection` +
      (api === DEFAULT_API ? "." : ", or the PIC2SVG_API_URL setting."),
    { cause: err },
  );
}

/** " (retry after N min)" from a Retry-After header, or "". */
function retryHint(res) {
  const retry = res.headers.get("retry-after");
  return retry ? ` (retry after ${Math.ceil(Number(retry) / 60)} min)` : "";
}

/**
 * The response started, then its body could not be read. An error status is
 * still reported as that status (a 429's wait matters more than the drop). A
 * dropped socket (undici: "terminated", UND_ERR_SOCKET, ECONNRESET) says so,
 * and that the trace was already counted: the server takes the allowance
 * before it traces. Anything else (a proxy's broken compression) is named as
 * an unreadable answer, not a drop.
 */
function describeBodyFailure(err, res, api) {
  const where = printable(api);
  if (!res.ok) {
    return new Error(`pic2svg returned ${res.status}: ${res.statusText || "error"}${retryHint(res)}`, { cause: err });
  }
  const code = err?.cause?.code ?? err?.code;
  const dropped =
    code === "UND_ERR_SOCKET" || code === "ECONNRESET" || (!code && err?.message === "terminated");
  if (dropped) {
    const left = res.headers.get("x-ratelimit-remaining");
    const counted = left === null ? "" : ` It already counted against today's allowance (${left} left).`;
    return new Error(
      `the connection to pic2svg at ${where} dropped before the answer finished (${code ?? "terminated"}).${counted} Try again.`,
      { cause: err },
    );
  }
  return new Error(
    `could not read pic2svg's answer from ${where} (${code ?? err?.cause?.message ?? err?.message ?? "unreadable body"}).`,
    { cause: err },
  );
}

/**
 * Trace one image. Returns the API's result
 * `{ svgText, mode, canvas: { w, h, paths }, sizeKB }`, plus `remaining`, the
 * caller's allowance left today when the server reports one.
 */
export async function trace({ imageBase64, fileName, preset = "balanced" }, { api = apiBase(), fetchImpl = fetch } = {}) {
  if (!PRESETS.includes(preset)) throw new Error(`preset must be one of ${PRESETS.join(", ")}`);
  if (imageBase64.length > MAX_BASE64_CHARS) {
    throw new Error("image too large: the server accepts about 45 MB at most");
  }
  let res;
  try {
    res = await fetchImpl(`${api}${TRACE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ imageBase64, fileName, preset }),
    });
  } catch (err) {
    throw describeFetchFailure(err, api);
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    throw describeBodyFailure(err, res, api);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const message = body?.message ?? text.slice(0, 300);
    throw new Error(`pic2svg returned ${res.status}: ${message || res.statusText}${retryHint(res)}`);
  }
  if (!body || typeof body.svgText !== "string") {
    throw new Error("pic2svg returned no SVG");
  }
  const remaining = res.headers.get("x-ratelimit-remaining");
  return { ...body, remaining: remaining === null ? null : Number(remaining) };
}
