import { strict as assert } from "node:assert";
import { test } from "node:test";
import { trace } from "./client.mjs";

const image = { imageBase64: "aGVsbG8=", fileName: "logo.png" };
// undici's real shape for a refused connection: TypeError("fetch failed") whose cause is an
// AggregateError carrying the code (and, inside, one error per address tried).
const refused = () => {
  const inner = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED" });
  const cause = Object.assign(new AggregateError([inner], ""), { code: "ECONNREFUSED" });
  return Promise.reject(new TypeError("fetch failed", { cause }));
};

test("an unreachable API names the address and the cause, and keeps the original error", async () => {
  await assert.rejects(trace(image, { api: "http://localhost:9", fetchImpl: refused }), (err) => {
    assert.equal(
      err.message,
      "could not reach pic2svg at http://localhost:9 (ECONNREFUSED). Check the network connection, or the PIC2SVG_API_URL setting.",
    );
    assert.ok(err.cause instanceof TypeError);
    return true;
  });
});

test("the default API gets the message without the setting hint", async () => {
  const offline = () =>
    Promise.reject(new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) }));
  await assert.rejects(trace(image, { api: "https://api.pic2svg.com", fetchImpl: offline }), {
    message: "could not reach pic2svg at https://api.pic2svg.com (ENOTFOUND). Check the network connection.",
  });
});

test("credentials in the address are never printed", async () => {
  await assert.rejects(trace(image, { api: "https://user:s3cret@127.0.0.1:9" }), (err) => {
    assert.doesNotMatch(err.message, /s3cret|user:/);
    return true;
  });
});

test("a broken fetchImpl is not mislabelled as a network problem", async () => {
  const buggy = () => Promise.reject(new ReferenceError("oops is not defined"));
  await assert.rejects(trace(image, { api: "http://x", fetchImpl: buggy }), { name: "ReferenceError" });
});

test("an HTTP error response still reports the server's status and message", async () => {
  const busy = () => Promise.resolve(new Response(JSON.stringify({ message: "daily limit" }), { status: 429 }));
  await assert.rejects(trace(image, { api: "http://x", fetchImpl: busy }), { message: "pic2svg returned 429: daily limit" });
});

test("a connection that drops mid-answer says so, not just 'terminated'", async () => {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"svgText":"<svg'));
      c.error(new TypeError("terminated", { cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }) }));
    },
  });
  const dropping = () =>
    Promise.resolve(new Response(body, { status: 200, headers: { "x-ratelimit-remaining": "41" } }));
  await assert.rejects(trace(image, { api: "http://localhost:9", fetchImpl: dropping }), (err) => {
    assert.equal(
      err.message,
      "the connection to pic2svg at http://localhost:9 dropped before the answer finished (UND_ERR_SOCKET). It already counted against today's allowance (41 left). Try again.",
    );
    assert.ok(err.cause);
    return true;
  });
});

const brokenBody = (cause) =>
  new ReadableStream({ start(c) { c.error(new TypeError("terminated", { cause })); } });

test("an error status whose body drops still reports the status and the wait", async () => {
  const limited = () =>
    Promise.resolve(new Response(brokenBody(Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" })), {
      status: 429, statusText: "Too Many Requests", headers: { "retry-after": "600" },
    }));
  await assert.rejects(trace(image, { api: "http://x", fetchImpl: limited }), {
    message: "pic2svg returned 429: Too Many Requests (retry after 10 min)",
  });
});

test("a body that cannot be decoded is not called a dropped connection", async () => {
  const garbled = () =>
    Promise.resolve(new Response(brokenBody(Object.assign(new Error("incorrect header check"), { code: "Z_DATA_ERROR" })), { status: 200 }));
  await assert.rejects(trace(image, { api: "http://x", fetchImpl: garbled }), {
    message: "could not read pic2svg's answer from http://x (Z_DATA_ERROR).",
  });
});

