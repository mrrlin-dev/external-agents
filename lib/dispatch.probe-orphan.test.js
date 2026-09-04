import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";

// A probe that outlives the process that started it is not a health check any
// more — it is a stray CLI holding an open socket to a provider for as long as
// the machine stays up. Three were found in the wild: two at ~9 minutes and one
// at 5h20m, all reparented to PID 1, two still ESTABLISHED to their provider's
// gateway. The 90s SIGKILL that should have ended them lives in the PARENT, so
// when the parent dies first the timer dies with it and nothing is left to fire.
//
// This test reproduces exactly that: start a probe whose CLI never returns, kill
// the parent, and require the CLI to be gone.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const alive = (marker) =>
  spawnSync("pgrep", ["-f", marker], { encoding: "utf-8" }).stdout.trim().split("\n").filter(Boolean);

async function waitFor(fn, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test("a probe CLI does not outlive the process that started it", async (t) => {
  const marker = `ea-probe-orphan-test-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-orphan-"));
  // $0 carries the marker so pgrep can find the CLI; it sleeps far longer than
  // the test, so anything still alive at the end is genuinely orphaned.
  const entry = {
    id: "orphan-probe-fixture",
    provider: "fixture",
    model: "fixture",
    // `; true` keeps it a COMPOUND command so bash does not exec into sleep and
    // drop the marker from argv — without it pgrep cannot see the probe at all.
    transports: { edit_exists: { cmd: `bash -c 'sleep 300; true' ${marker}` } },
  };
  const runner = path.join(dir, "runner.mjs");
  fs.writeFileSync(
    runner,
    `import { auditCliEntry } from ${JSON.stringify(path.join(repoRoot, "lib", "dispatch.js"))};\n`
    + `auditCliEntry(${JSON.stringify(entry)}).then(() => {});\n`
    + `setInterval(() => {}, 1000);\n`,
  );

  const parent = spawn(process.execPath, [runner], { stdio: "ignore" });
  t.after(() => {
    try { parent.kill("SIGKILL"); } catch {}
    for (const pid of alive(marker)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(await waitFor(() => alive(marker).length > 0), "the probe CLI should have started");

  // SIGTERM is what a harness timeout, a `kill`, or a supervisor sends. The
  // parent must take its probe with it.
  parent.kill("SIGTERM");
  const gone = await waitFor(() => alive(marker).length === 0);
  assert.ok(gone, `probe CLI survived its parent as an orphan: pids ${alive(marker).join(",")}`);
});

// This module is imported by the long-running server too, so its reaper must not
// behave like it owns the process. Wiping every listener for a signal would
// silently cancel a consumer's own shutdown — `cli.js` already registers SIGINT
// and SIGTERM handlers of its own for a different subcommand.
test("reaping a signal leaves other listeners for it intact", async (t) => {
  const marker = `ea-probe-coexist-${process.pid}-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-orphan-coexist-"));
  const entry = {
    id: "orphan-probe-fixture",
    provider: "fixture",
    model: "fixture",
    transports: { edit_exists: { cmd: `bash -c 'sleep 300; true' ${marker}` } },
  };
  const flag = path.join(dir, "consumer-ran");
  const runner = path.join(dir, "runner.mjs");
  fs.writeFileSync(
    runner,
    `import fs from "node:fs";\n`
    + `import { auditCliEntry } from ${JSON.stringify(path.join(repoRoot, "lib", "dispatch.js"))};\n`
    // A consumer's own handler, registered before any probe exists.
    + `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(flag)}, "yes"); process.exit(7); });\n`
    + `auditCliEntry(${JSON.stringify(entry)}).then(() => {});\n`
    + `setInterval(() => {}, 1000);\n`,
  );

  const parent = spawn(process.execPath, [runner], { stdio: "ignore" });
  t.after(() => {
    try { parent.kill("SIGKILL"); } catch {}
    for (const pid of alive(marker)) { try { process.kill(Number(pid), "SIGKILL"); } catch {} }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.ok(await waitFor(() => alive(marker).length > 0), "the probe CLI should have started");
  parent.kill("SIGTERM");

  assert.ok(await waitFor(() => alive(marker).length === 0), "the probe should still be reaped");
  assert.ok(await waitFor(() => fs.existsSync(flag)), "the consumer's own SIGTERM handler must still run");
});

// A library may borrow the process's signals for the length of an operation; it
// may not keep them afterwards. Three reviewers called the permanent listeners a
// scope violation for a module the long-running server imports, and they were
// right: the handlers now come and go with the probes themselves.
test("the process's signal handlers are given back once no probe is in flight", async () => {
  const { auditCliEntry } = await import("./dispatch.js");
  const counts = () => Object.fromEntries(
    ["SIGINT", "SIGTERM", "SIGHUP", "exit"].map((s) => [s, process.listenerCount(s)]),
  );
  const before = counts();
  // A command that exits immediately, so the probe completes on its own.
  await auditCliEntry({
    id: "fixture-fast",
    provider: "fixture",
    model: "fixture",
    transports: { edit_exists: { cmd: "true ;" } },
  });
  assert.deepEqual(counts(), before, "every borrowed listener must be handed back");
});
