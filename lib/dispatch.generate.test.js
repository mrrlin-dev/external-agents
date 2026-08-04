import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { runGenerate } from "./dispatch.js";

test("runGenerate rejects a successful HTTP response with empty content", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await runGenerate(
      {
        id: "empty",
        model: "fixture",
        transports: { generate_new: { url: `http://127.0.0.1:${port}`, model: "fixture" } },
      },
      "reply",
    );
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /empty generated output/i);
    assert.deepEqual(result.files, []);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runGenerate keeps its timeout active while reading a stalled response body", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const started = Date.now();
    const result = await runGenerate(
      {
        id: "stalled-body",
        model: "fixture",
        transports: { generate_new: { url: `http://127.0.0.1:${port}`, model: "fixture" } },
      },
      "reply",
      { timeoutMs: 50 },
    );
    assert.equal(result.exitCode, 124);
    assert.ok(Date.now() - started < 500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
