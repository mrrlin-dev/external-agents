import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  aiderExitCode,
  declaredMarkerExitCode,
  hasSubstantiveOutput,
  normalizeFailureMarkers,
  emptyRunExitCode,
} from "./dispatch.js";

// The failure this file exists for, recorded verbatim from the dispatch log:
//
//   12:12:29  openrouter-minimax-m3-free  edit_exists  success  exit=0  32777ms
//
// The content was nothing but rate-limit errors and no plan was produced, and
// the sidecar failure log had no row for it — only failures are recorded, and
// this was not counted as one. Both guards for the class opened with
// `files.length > 0`, and aider had touched the declared plan path into
// existence, so a single 0-byte file made the run look like work.
const RATE_LIMITED = "litellm.RateLimitError: OpenrouterException - {\"error\":{\"code\":429}}\nRetrying in 0.2 seconds...";

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ea-false-success-"));
}

test("the regression shape: a 0-byte file plus provider errors is a failure", () => {
  assert.equal(aiderExitCode(0, true, RATE_LIMITED, "", [{ path: "plan-b.md", bytes: 0 }]), 1);
});

test("a 0-byte file with a clean run stays a success", () => {
  // Decision 1: the 0-byte rule lives ONLY in the provider-error guard, so
  // "create an empty placeholder" is untouched. This is the false positive the
  // first design round was dissented for.
  assert.equal(aiderExitCode(0, true, "created the file you asked for", "", [{ path: "p.md", bytes: 0 }]), 0);
});

test("a run that produced real content stays a success even with errors in the log", () => {
  // A retry that eventually succeeded prints the failed attempts too.
  assert.equal(aiderExitCode(0, true, RATE_LIMITED + "\nApplied edit to plan.md", "", [{ path: "plan.md", bytes: 27800 }]), 0);
});

test("a deletion counts as work despite carrying no bytes", () => {
  // Without this clause a successful deletion is re-coded as a failure, which
  // is worse than the bug being fixed.
  for (const status of ["D", "D ", " D", "R", "RM"]) {
    assert.equal(
      aiderExitCode(0, true, RATE_LIMITED, "", [{ path: "gone.md", status }]),
      0,
      `status ${JSON.stringify(status)} should count as work`,
    );
  }
});

test("a non-aider entry is guarded only by the markers it declares", () => {
  const files = [{ path: "out.md", bytes: 0 }];
  const kiro = "Monthly request limit reached";
  // Declared → caught.
  assert.equal(declaredMarkerExitCode(0, [kiro], kiro, "", files), 1);
  // Declared, on stderr instead → caught.
  assert.equal(declaredMarkerExitCode(0, [kiro], "", kiro, files), 1);
  // Nothing declared → behaviour unchanged. No inference, no guessing.
  assert.equal(declaredMarkerExitCode(0, undefined, kiro, "", files), 0);
  assert.equal(declaredMarkerExitCode(0, [], kiro, "", files), 0);
  // Declared but absent from the output → success.
  assert.equal(declaredMarkerExitCode(0, [kiro], "here is the answer", "", files), 0);
});

test("an empty or non-string marker is ignored rather than matching everything", () => {
  assert.deepEqual(normalizeFailureMarkers(["", "  ", null, 7, "real"]), ["real"]);
  assert.equal(declaredMarkerExitCode(0, ["", "   "], "any output at all", "", [{ path: "p", bytes: 0 }]), 0);
});

test("prose that merely mentions a rate limit is not a failure", () => {
  // This repository writes plans about 429 handling regularly. A guard that
  // re-coded those would be worse than the bug.
  const answer = "The plan handles a 429 by backing off; see step 3 for the retry budget.";
  assert.equal(declaredMarkerExitCode(0, ["Monthly request limit reached"], answer, "", [{ path: "p.md", bytes: 4000 }]), 0);
  assert.equal(aiderExitCode(0, true, answer, "", [{ path: "p.md", bytes: 4000 }]), 0);
});

test("bytes are resolved from disk when the listing has none (the git porcelain path)", () => {
  // listChangedFiles → parseGitPorcelain returns {path, status} with NO bytes,
  // so the guard resolves them itself rather than changing that shape.
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "empty.md"), "");
  fs.writeFileSync(path.join(dir, "full.md"), "a plan");
  assert.equal(hasSubstantiveOutput([{ path: "empty.md", status: "??" }], dir), false);
  assert.equal(hasSubstantiveOutput([{ path: "full.md", status: "M" }], dir), true);
  // Mixed: one file with content is enough, and the loop short-circuits on it.
  assert.equal(hasSubstantiveOutput([{ path: "empty.md", status: "??" }, { path: "full.md", status: "M" }], dir), true);
});

test("a path outside the workdir is never counted, however it escapes", () => {
  const dir = tmpdir();
  const outside = path.join(tmpdir(), "outside.md");
  fs.writeFileSync(outside, "content that must not count as this run's work");
  // Absolute path.
  assert.equal(hasSubstantiveOutput([{ path: outside, status: "M" }], dir), false);
  // Traversal.
  assert.equal(hasSubstantiveOutput([{ path: path.join("..", path.basename(path.dirname(outside)), "outside.md"), status: "M" }], dir), false);
  // A SYMLINK inside the workdir pointing out of it — this passes a plain
  // string-prefix test on the unresolved path, which is why the candidate is
  // realpath-ed and not just the root.
  fs.symlinkSync(outside, path.join(dir, "link.md"));
  assert.equal(hasSubstantiveOutput([{ path: "link.md", status: "??" }], dir), false);
});

test("a path that cannot be resolved is not evidence of work", () => {
  // Fail closed. Safe only because every caller reaches this after a
  // provider-error pattern already matched.
  const dir = tmpdir();
  assert.equal(hasSubstantiveOutput([{ path: "never-created.md", status: "??" }], dir), false);
  // A dangling symlink: realpathSync throws ENOENT, handled as "no content".
  fs.symlinkSync(path.join(dir, "nothing-here"), path.join(dir, "dangling.md"));
  assert.equal(hasSubstantiveOutput([{ path: "dangling.md", status: "??" }], dir), false);
  // No workdir to resolve against, and no bytes in the listing → cannot confirm.
  assert.equal(hasSubstantiveOutput([{ path: "x.md", status: "??" }], undefined), false);
});

test("emptyRunExitCode is untouched: any file still counts as work there", () => {
  // Decision 1 deliberately leaves this function alone, so the silent
  // empty-file case keeps its current behaviour on every CLI transport.
  assert.equal(emptyRunExitCode(0, "", "", [{ path: "p.md", bytes: 0 }]), 0);
  assert.equal(emptyRunExitCode(0, "", "", []), 1);
});

test("end to end: a CLI that prints a declared marker, touches an empty file and exits 0 is a failure", async () => {
  // The unit tests above cover the rule; this one covers the WIRING — that
  // runDispatch actually threads the transport's markers and its workdir into
  // the guard. The observed failure was exactly this shape, and no unit test
  // would have caught a guard that was never called.
  const { runDispatch } = await import("./dispatch.js");
  const dir = tmpdir();
  const fakeCli = path.join(dir, "fake-cli.sh");
  fs.writeFileSync(
    fakeCli,
    "#!/bin/sh\ntouch \"$PWD/plan-b.md\"\necho 'Monthly request limit reached'\nexit 0\n",
    { mode: 0o755 },
  );

  const entry = {
    id: "fake-marker-cli",
    transports: { edit_exists: { cmd: `sh ${fakeCli}`, failure_markers: ["Monthly request limit reached"] } },
  };
  const result = await runDispatch(entry, "write the plan", { timeoutMs: 30000 }, "edit_exists");

  assert.equal(result.exitCode, 1, "exit 0 with a declared marker and an empty file must be a failure");
  assert.ok(
    result.files.some((f) => f.path === "plan-b.md" && f.bytes === 0),
    `the 0-byte file that used to mask this should still be reported: ${JSON.stringify(result.files)}`,
  );
});

test("end to end: the same CLI without declared markers keeps its old behaviour", async () => {
  const { runDispatch } = await import("./dispatch.js");
  const dir = tmpdir();
  const fakeCli = path.join(dir, "fake-cli.sh");
  fs.writeFileSync(
    fakeCli,
    "#!/bin/sh\ntouch \"$PWD/plan-b.md\"\necho 'Monthly request limit reached'\nexit 0\n",
    { mode: 0o755 },
  );
  const entry = { id: "fake-no-markers", transports: { edit_exists: { cmd: `sh ${fakeCli}` } } };
  const result = await runDispatch(entry, "write the plan", { timeoutMs: 30000 }, "edit_exists");
  assert.equal(result.exitCode, 0, "an entry that declares nothing must be unaffected");
});

// ── The same class on the HTTP path ────────────────────────────────────────────
// Deferred once with a recorded reason, then closed by separating the two halves
// it had been treating as one: a provider error in a 200 ENVELOPE is structured
// evidence, while a 200 whose CONTENT discusses a rate limit is the model's
// answer and must stay a success.

import http from "node:http";
import { envelopeError, runGenerate, classifyDispatchFailure } from "./dispatch.js";

function serve(status, payload) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/v1/chat/completions`,
        // Awaited by every caller: a listening handle that outlives its test is
        // the classic source of an intermittent runner failure, and this file saw
        // exactly one unreproducible one before the close was awaited.
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function httpEntry(url) {
  return {
    id: "envelope-test",
    model: "test-model",
    // Sentinel the auth branch already honours, so no key is needed.
    transports: { generate_new: { url, env: "OLLAMA_UNUSED_KEY", model: "test-model" } },
  };
}

test("envelopeError reads the shapes providers actually send, and only those", () => {
  assert.deepEqual(
    envelopeError({ error: { code: 429, message: "Rate limit exceeded" } }),
    { message: "Rate limit exceeded", status: 429 },
  );
  // A slug code is not a status, but it belongs in the message so the
  // classifier can still see what happened.
  assert.deepEqual(
    envelopeError({ error: { code: "rate_limit_exceeded", message: "slow down" } }),
    { message: "slow down — rate_limit_exceeded", status: null },
  );
  assert.deepEqual(envelopeError({ error: "upstream unavailable" }), { message: "upstream unavailable", status: null });
  assert.equal(envelopeError({ error: "   " }), null);
  assert.equal(envelopeError({ choices: [{ message: { content: "a real answer" } }] }), null);
  assert.equal(envelopeError({}), null);
  assert.equal(envelopeError(null), null);
});

test("end to end: a 429 inside a 200 envelope is a failure that reports as HTTP 429", async () => {
  // Before this, `content` was empty so the run was reported as "empty generated
  // output" — a real quota event scored as a generic fault, so the agent got the
  // transient ladder instead of a quota cooldown and the shared free-tier bucket
  // was never marked.
  const s = await serve(200, { error: { code: 429, message: "Rate limit exceeded: free-tier daily limit" } });
  try {
    const r = await runGenerate(httpEntry(s.url), "hi", {});
    assert.equal(r.exitCode, 1);
    assert.equal(r.status, 429, "the envelope's numeric code stands in for the HTTP status");
    assert.match(r.stderr, /Rate limit exceeded/);
    assert.equal(r.output, "", "there is no answer to hand back");
    assert.equal(
      classifyDispatchFailure(r.stderr + "\n" + r.output).isExhaustion,
      true,
      "must be scored as exhaustion, which is what triggers the cooldown and the bucket collapse",
    );
  } finally {
    await s.close();
  }
});

test("end to end: a normal 200 is untouched", async () => {
  const s = await serve(200, { choices: [{ message: { content: "here is the plan" } }], usage: { completion_tokens: 4 } });
  try {
    const r = await runGenerate(httpEntry(s.url), "hi", {});
    assert.equal(r.exitCode, 0);
    assert.equal(r.output, "here is the plan");
  } finally {
    await s.close();
  }
});

test("end to end: an answer that DISCUSSES a rate limit stays a success", async () => {
  // The deliberate non-behaviour, pinned by a test so nobody "improves" it into
  // prose-guessing: inferring failure from the model's own words is exactly what
  // four rounds of consensus rejected for the CLI guard.
  const prose = "If the provider answers 429, back off and retry; see step 3 for the budget.";
  const s = await serve(200, { choices: [{ message: { content: prose } }] });
  try {
    const r = await runGenerate(httpEntry(s.url), "hi", {});
    assert.equal(r.exitCode, 0, "prose about a rate limit is an answer, not a failure");
    assert.equal(r.output, prose);
  } finally {
    await s.close();
  }
});
