import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readFailureLogConfig,
  setFailureLogEnabled,
  recordFailure,
  readFailures,
  redact,
  capRaw,
  sanitizeArgv,
  isSecretEnvName,
  SCHEMA,
} from "./failure-log.js";

function tmp(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-failure-log-test-"));
  return path.join(dir, name);
}

function withEnv(patch, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patch)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const CLEAN_ENV = {
  EXTERNAL_AGENTS_FAILURE_LOG: undefined,
  EXTERNAL_AGENTS_FAILURE_LOG_PROMPT: undefined,
  EXTERNAL_AGENTS_FAILURE_LOG_MAX_RAW_BYTES: undefined,
};

test("off by default — no config file, no env", () => {
  withEnv(CLEAN_ENV, () => {
    const cfg = readFailureLogConfig({ configFile: tmp("nope.json") });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.include_prompt, false);
  });
});

test("disabled means nothing is written at all", () => {
  withEnv(CLEAN_ENV, () => {
    const file = tmp("failures.jsonl");
    const written = recordFailure(
      { stage: "dispatch", agent_id: "x", raw: { stderr: "boom" } },
      { file, configFile: tmp("nope.json") },
    );
    assert.equal(written, null);
    assert.equal(fs.existsSync(file), false);
  });
});

test("the flag lives in a file, so it survives a package upgrade", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    setFailureLogEnabled(true, { configFile });
    assert.equal(readFailureLogConfig({ configFile }).enabled, true);
    // Simulating the upgrade: the package is replaced, the state dir is not.
    // Re-reading the same untouched file must still say ON.
    assert.equal(readFailureLogConfig({ configFile }).enabled, true);
    setFailureLogEnabled(false, { configFile });
    assert.equal(readFailureLogConfig({ configFile }).enabled, false);
  });
});

test("toggling preserves unrelated keys in config.json", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, JSON.stringify({ something_else: { keep: 1 } }));
    setFailureLogEnabled(true, { configFile });
    const parsed = JSON.parse(fs.readFileSync(configFile, "utf-8"));
    assert.deepEqual(parsed.something_else, { keep: 1 });
    assert.equal(parsed.failure_log.enabled, true);
  });
});

test("env overrides the file in both directions", () => {
  const configFile = tmp("config.json");
  withEnv(CLEAN_ENV, () => setFailureLogEnabled(false, { configFile }));
  withEnv({ ...CLEAN_ENV, EXTERNAL_AGENTS_FAILURE_LOG: "1" }, () => {
    assert.equal(readFailureLogConfig({ configFile }).enabled, true);
  });
  withEnv(CLEAN_ENV, () => setFailureLogEnabled(true, { configFile }));
  withEnv({ ...CLEAN_ENV, EXTERNAL_AGENTS_FAILURE_LOG: "0" }, () => {
    assert.equal(readFailureLogConfig({ configFile }).enabled, false);
  });
});

test("a recorded failure keeps the raw streams whole, not a 400-char preview", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    const file = tmp("failures.jsonl");
    setFailureLogEnabled(true, { configFile });
    // Longer than the dispatch log's 400-char clip, with the actionable line
    // at the very front — exactly the shape that clip destroys.
    const stderr = "FATAL: model 'x' was decommissioned on 2026-01-01\n" + "progress ".repeat(200);
    recordFailure(
      {
        stage: "dispatch",
        agent_id: "groq-thing",
        outcome: "error",
        reason: "HTTP 400",
        raw: { stderr },
      },
      { file, configFile },
    );
    const [row] = readFailures(10, { file });
    assert.equal(row.schema, SCHEMA);
    assert.equal(row.stage, "dispatch");
    assert.equal(row.raw.stderr, stderr);
    assert.ok(row.raw.stderr.length > 400);
    assert.ok(row.iso);
  });
});

test("the numbered multi-key naming this pool actually uses is redacted", () => {
  // The regression the consensus panel caught. The name test used to be
  // end-anchored, so GEMINI_API_KEY_3 / GROQ_API_KEY_2 / OPENROUTER_API_KEY_2 —
  // the convention every multi-key setup here follows — matched nothing, and
  // every one of those keys would have been written out in the clear.
  const configFile = tmp("config.json");
  const file = tmp("failures.jsonl");
  withEnv(
    {
      ...CLEAN_ENV,
      GEMINI_API_KEY_3: "geminikeyvalue000001",
      GROQ_API_KEY_2: "groqkeyvalue00000002",
      OPENROUTER_API_KEY_2: "orkeyvalue0000000003",
    },
    () => {
      setFailureLogEnabled(true, { configFile });
      recordFailure(
        {
          stage: "dispatch",
          agent_id: "a",
          raw: {
            stderr: "tried geminikeyvalue000001 then groqkeyvalue00000002 then orkeyvalue0000000003",
          },
        },
        { file, configFile },
      );
      const contents = fs.readFileSync(file, "utf-8");
      for (const secret of ["geminikeyvalue000001", "groqkeyvalue00000002", "orkeyvalue0000000003"]) {
        assert.ok(!contents.includes(secret), `${secret} leaked into the log`);
      }
      assert.ok(contents.includes("GEMINI_API_KEY_3"));
    },
  );
});

test("PAT and PSK names, and a fine-grained GitHub token, are redacted", () => {
  // A later consensus round measured these against live values: GH_PAT,
  // GITHUB_PAT and MY_PSK all returned false, and github_pat_… matched no
  // pattern either — so a fine-grained GitHub token held in GH_PAT passed the
  // value pass, the pattern pass AND the serialised backstop, in the clear.
  assert.equal(isSecretEnvName("GH_PAT"), true);
  assert.equal(isSecretEnvName("GITHUB_PAT"), true);
  assert.equal(isSecretEnvName("MY_PSK"), true);
  assert.equal(isSecretEnvName("PSK"), true);
  // PAT is safe as a whole SEGMENT and must never reach the substring pass,
  // where it would swallow PATH — the variable every process on the machine has.
  assert.equal(isSecretEnvName("PATH"), false);
  assert.equal(isSecretEnvName("PATIENT_NAME"), false);
  assert.equal(isSecretEnvName("COMPAT_MODE"), false);
  // Pattern pass alone, for a token this process never held.
  const token = "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz1234567890AB";
  assert.ok(!redact(`rejected ${token} at 401`, {}).includes(token));
});

test("a password embedded in a connection string is redacted by shape", () => {
  // DATABASE_URL, REDIS_URL and AMQP_URL are named after the service, not after
  // the password inside them, so the name-based value pass never sees them.
  // Shape catches what naming cannot.
  assert.equal(isSecretEnvName("DATABASE_URL"), false);
  const out = redact("connect postgres://user:hunter2longpassword@db.example.com/x failed", {});
  assert.ok(!out.includes("hunter2longpassword"));
  // The scheme, the user and the host are the diagnostic half and must survive.
  assert.ok(out.includes("postgres://user:"));
  assert.ok(out.includes("@db.example.com/x"));
  // A URL with no credentials in it is left exactly alone, as is an SSH remote.
  const plain = "see https://example.com/docs and git@github.com:me/repo.git";
  assert.equal(redact(plain, {}), plain);
});

test("an existing log file with wider permissions is tightened to 0600", () => {
  // `mode` on appendFileSync applies at CREATION only, so a file left behind by
  // an earlier version — or by a redirected EXTERNAL_AGENTS_FAILURE_LOG_FILE —
  // would keep whatever mode it had while receiving raw provider output.
  const configFile = tmp("config.json");
  const file = tmp("failures.jsonl");
  fs.writeFileSync(file, "", { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  withEnv({ ...CLEAN_ENV }, () => {
    setFailureLogEnabled(true, { configFile });
    recordFailure({ stage: "dispatch", agent_id: "a", raw: { stderr: "boom" } }, { file, configFile });
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test("a secret containing JSON-escaped characters cannot ride out in an unmodeled field", () => {
  // The backstop runs over the serialised line, so a secret holding a quote or a
  // backslash no longer appears literally by the time it gets there. Raised as a
  // nice-to-have by the round-2 panel; cheap enough to just close.
  const configFile = tmp("config.json");
  const file = tmp("failures.jsonl");
  const secret = 'pw"with\\quotes\nand-newline-0001';
  withEnv({ ...CLEAN_ENV, WEIRD_API_KEY: secret }, () => {
    setFailureLogEnabled(true, { configFile });
    recordFailure(
      // response_headers is a field the module does not model, so only the
      // serialised backstop can catch it.
      { stage: "dispatch", agent_id: "a", response_headers: { "x-echo": secret }, raw: { stderr: "boom" } },
      { file, configFile },
    );
    const contents = fs.readFileSync(file, "utf-8");
    assert.ok(!contents.includes(JSON.stringify(secret).slice(1, -1)), "escaped secret leaked");
    assert.ok(!contents.includes(secret), "literal secret leaked");
  });
});

test("undelimited PSK names are caught by the substring pass", () => {
  assert.equal(isSecretEnvName("MYPSK"), true);
  assert.equal(isSecretEnvName("PATH"), false);
});

test("names that merely contain a secret word are not treated as secrets", () => {
  // The cost of loosening the name match is over-redaction, which would blank
  // ordinary values out of the middle of diagnostic text. Segment matching is
  // what keeps AUTHOR and KEYBOARD_LAYOUT out of it.
  assert.equal(isSecretEnvName("AUTHOR"), false);
  assert.equal(isSecretEnvName("KEYBOARD_LAYOUT"), false);
  assert.equal(isSecretEnvName("PATH"), false);
  assert.equal(isSecretEnvName("HOMEBREW_PREFIX"), false);
  assert.equal(isSecretEnvName("GEMINI_API_KEY_3"), true);
  assert.equal(isSecretEnvName("AWS_SECRET_ACCESS_KEY"), true);
  assert.equal(isSecretEnvName("anthropic_auth_token"), true);
  // Undelimited forms: one word to the splitter, so they need the substring
  // pass. Raised by the round-2 reviewer.
  assert.equal(isSecretEnvName("MYAPIKEY"), true);
  assert.equal(isSecretEnvName("DEEPSEEKTOKEN"), true);
  assert.equal(isSecretEnvName("MYSECRET"), true);
  assert.equal(isSecretEnvName("PASSPHRASE"), true);
  // The substring pass is confined to undelimited names, so a delimited name
  // that merely contains a secret word is judged by its segments and stays out.
  assert.equal(isSecretEnvName("SECRETARY_EMAIL"), false);
  assert.equal(isSecretEnvName("TOKENIZERS_PARALLELISM"), false);
});

test("secrets from the environment never reach the file", () => {
  const configFile = tmp("config.json");
  const file = tmp("failures.jsonl");
  withEnv({ ...CLEAN_ENV, SOME_PROVIDER_API_KEY: "supersecretvalue1234" }, () => {
    setFailureLogEnabled(true, { configFile });
    recordFailure(
      {
        stage: "dispatch",
        agent_id: "a",
        reason: "auth failed for supersecretvalue1234",
        raw: { stderr: "Authorization: Bearer supersecretvalue1234 rejected" },
      },
      { file, configFile },
    );
    const contents = fs.readFileSync(file, "utf-8");
    assert.ok(!contents.includes("supersecretvalue1234"), "raw secret leaked into the log");
    assert.ok(contents.includes("SOME_PROVIDER_API_KEY"));
  });
});

test("a secret in a field this module does not know about is still caught", () => {
  const configFile = tmp("config.json");
  const file = tmp("failures.jsonl");
  withEnv({ ...CLEAN_ENV, WEIRD_TOKEN: "tok_abcdefghijklmnop" }, () => {
    setFailureLogEnabled(true, { configFile });
    recordFailure(
      // response_headers is passed straight through by the record builder.
      { stage: "dispatch", agent_id: "a", response_headers: { "x-echo": "tok_abcdefghijklmnop" } },
      { file, configFile },
    );
    assert.ok(!fs.readFileSync(file, "utf-8").includes("tok_abcdefghijklmnop"));
  });
});

test("prompts are elided by default and included on request", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    const file = tmp("failures.jsonl");
    setFailureLogEnabled(true, { configFile });
    const prompt = "refactor the billing module";
    recordFailure(
      { stage: "dispatch", agent_id: "a", prompt_text: prompt, command: { cmd: "cli", argv: ["--print", prompt] } },
      { file, configFile },
    );
    const [row] = readFailures(1, { file });
    assert.equal(row.prompt_text, undefined);
    assert.match(row.command.argv[1], /prompt elided: 27 bytes/);
    assert.equal(row.command.argv[0], "--print");
  });

  withEnv({ ...CLEAN_ENV, EXTERNAL_AGENTS_FAILURE_LOG: "1", EXTERNAL_AGENTS_FAILURE_LOG_PROMPT: "1" }, () => {
    const configFile = tmp("config.json");
    const file = tmp("failures.jsonl");
    const prompt = "refactor the billing module";
    recordFailure(
      { stage: "dispatch", agent_id: "a", prompt_text: prompt, command: { cmd: "cli", argv: ["--print", prompt] } },
      { file, configFile },
    );
    const [row] = readFailures(1, { file });
    assert.equal(row.prompt_text, prompt);
    assert.equal(row.command.argv[1], prompt);
  });
});

test("capRaw does not split a multi-byte character at either boundary", () => {
  // Solid multi-byte text: every cut offset lands inside a character, so a
  // naive Buffer slice produces U+FFFD at the head's end and the tail's start.
  const text = "日".repeat(4000);
  const capped = capRaw(text, 1001);
  assert.ok(!capped.includes("\uFFFD"), "capRaw produced a replacement character");
  assert.match(capped, /bytes elided from the middle/);
});

test("capRaw keeps both ends and says what it dropped", () => {
  const text = "HEAD" + "x".repeat(5000) + "TAIL";
  const capped = capRaw(text, 200);
  assert.ok(capped.startsWith("HEAD"));
  assert.ok(capped.endsWith("TAIL"));
  assert.match(capped, /bytes elided from the middle/);
  assert.ok(capped.length < text.length);
  // Under the cap it must be byte-identical, not merely similar.
  assert.equal(capRaw(text, 999999), text);
});

test("redact catches key-shaped strings this process never held", () => {
  const out = redact("key=sk-abcdefghijklmnopqrstuvwxyz and AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01", {});
  assert.ok(!out.includes("sk-abcdefghijklmnopqrstuvwxyz"));
  assert.ok(!out.includes("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ01"));
});

test("redact leaves ordinary error text alone", () => {
  const text = "ENOENT: no such file or directory, open '/tmp/whatever.md'";
  assert.equal(redact(text, {}), text);
});

test("sanitizeArgv redacts flag-carried credentials", () => {
  const argv = sanitizeArgv(["--api-key", "abcdefghijklmnop"], null, false, { MY_API_KEY: "abcdefghijklmnop" });
  assert.equal(argv[1], "«redacted:MY_API_KEY»");
});

test("a torn last line does not break readback", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    const file = tmp("failures.jsonl");
    setFailureLogEnabled(true, { configFile });
    recordFailure({ stage: "dispatch", agent_id: "a" }, { file, configFile });
    fs.appendFileSync(file, '{"stage":"dispatch","agent_id":"trunc');
    const rows = readFailures(10, { file });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].agent_id, "a");
  });
});

test("the log rotates instead of growing without limit", () => {
  withEnv(CLEAN_ENV, () => {
    const configFile = tmp("config.json");
    const file = tmp("failures.jsonl");
    setFailureLogEnabled(true, { configFile });
    const cfg = { ...readFailureLogConfig({ configFile }), max_file_bytes: 500 };
    for (let i = 0; i < 20; i++) {
      recordFailure({ stage: "dispatch", agent_id: `agent-${i}`, raw: { stderr: "x".repeat(100) } }, { file, config: cfg });
    }
    assert.ok(fs.statSync(file).size < 5000, "current generation should have rotated");
  });
});
