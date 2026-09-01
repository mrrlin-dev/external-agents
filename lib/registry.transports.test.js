import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import yaml from "js-yaml";
import { parseCliUsage } from "./cli-usage.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundledRegistry = yaml.load(fs.readFileSync(path.join(repoRoot, "agents.yaml"), "utf-8"));

test("bundled edit_exists transports use direct CLIs while generate_new remains available", () => {
  const agents = bundledRegistry.agents;
  const editCommands = agents
    .map((agent) => agent.transports?.edit_exists)
    .filter(Boolean)
    .map((transport) => typeof transport === "string" ? transport : transport.cmd);

  assert.ok(editCommands.length > 0);
  assert.ok(editCommands.every((command) => typeof command === "string" && command.trim()));
  assert.ok(agents.some((agent) => agent.transports?.generate_new));

  for (const id of ["codex", "claude-opus-5"]) {
    const agent = agents.find((candidate) => candidate.id === id);
    assert.ok(agent, `${id} must remain a bundled direct-CLI edit agent`);
    assert.ok(agent.transports?.edit_exists, `${id} must declare edit_exists`);
  }
});

test("bundled read_only transports never reuse their entry's edit_exists command verbatim", () => {
  // A read_only cmd identical to edit_exists is definitionally not read-only —
  // this is the exact class of unverified claim the axis exists to prevent.
  const agents = bundledRegistry.agents;
  for (const agent of agents) {
    const ro = agent.transports?.read_only;
    const editCmd = agent.transports?.edit_exists;
    if (!ro) continue;
    if (typeof ro === "object" && ro.via) continue; // via:generate_new has no cmd to compare
    const roCmd = typeof ro === "string" ? ro : ro.cmd;
    const editCmdStr = typeof editCmd === "string" ? editCmd : editCmd?.cmd;
    assert.notEqual(roCmd, editCmdStr, `${agent.id}'s read_only cmd must differ from its edit_exists cmd`);
  }
});

test("kiro and the anthropic CLI entries declare a read_only command", () => {
  const agents = bundledRegistry.agents;
  for (const id of ["kiro", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
    const agent = agents.find((candidate) => candidate.id === id);
    assert.ok(agent, `${id} must remain bundled`);
    const ro = agent.transports?.read_only;
    assert.ok(ro, `${id} must declare a read_only transport`);
    assert.ok(typeof (typeof ro === "string" ? ro : ro.cmd) === "string" && (typeof ro === "string" ? ro : ro.cmd).trim());
  }
});

test("the anthropic CLI read_only commands don't claim effort support (untested with their trailing --)", () => {
  // runDispatch appends the effort flag right before the prompt — i.e. AFTER
  // this cmd's trailing `--`, which was confirmed to swallow the prompt
  // entirely rather than erroring loudly. Do not add effort fields here until
  // that interaction is fixed and verified; a silent prompt loss is worse
  // than declining to offer effort tuning on the reviewer path.
  const agents = bundledRegistry.agents;
  for (const id of ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"]) {
    const ro = agents.find((a) => a.id === id).transports.read_only;
    assert.equal(ro.effort_levels, undefined, `${id}'s read_only cmd must not declare effort_levels`);
  }
});

// ---------------------------------------------------------------------------
// `usage_from` and `--output-format` are two hand-maintained halves of one
// mechanism, and nothing used to check that they agree.
//
// The failure is silent in both directions and neither one raises an error:
//   - drop the flag, keep `usage_from` → the CLI prints prose, parseCliUsage
//     returns null by design, and the seat goes back to reporting no tokens at
//     all. That invisibility is the exact condition 0.54.0 existed to end: 1574
//     CLI dispatches with no usage, including every `claude` one.
//   - keep the flag, drop `usage_from` → nothing unwraps the envelope, so the
//     caller's ANSWER becomes a blob of JSON instead of the text inside it.
//
// So the check is bidirectional, and it is deliberately written to fail when
// somebody adds a CLI whose flag spelling is not listed here: adding the
// spelling is how the two halves stay edited together.
// ---------------------------------------------------------------------------

// The format token a command asks for, or null if it asks for nothing.
const OUTPUT_FORMAT = /(?:--output-format[= ]([A-Za-z-]+))|(?:^|\s)--(json)(?=\s|$)/;
// Which parseCliUsage `kind` each format token implies. `text` is present and
// maps to nothing on purpose: cursor-agent asks for text and correctly declares
// no usage_from, and that must stay legal.
const KIND_FOR_FORMAT = { json: "json", "stream-json": "jsonl", jsonl: "jsonl", ndjson: "jsonl", text: null };

function cliCommands(agent) {
  return Object.entries(agent.transports || {})
    .map(([name, t]) => [name, typeof t === "string" ? t : t?.cmd])
    .filter(([, cmd]) => typeof cmd === "string" && cmd.trim());
}

function requestedFormat(cmd) {
  const m = cmd.match(OUTPUT_FORMAT);
  if (!m) return null;
  return (m[1] || m[2]).toLowerCase();
}

test("a bundled entry that declares usage_from asks every one of its CLIs for that format", () => {
  for (const agent of bundledRegistry.agents) {
    if (!agent.usage_from) continue;
    const cmds = cliCommands(agent);
    assert.ok(cmds.length > 0, `${agent.id} declares usage_from but has no CLI transport to parse`);
    for (const [name, cmd] of cmds) {
      const format = requestedFormat(cmd);
      assert.ok(
        format,
        `${agent.id}.${name} must ask for structured output — it declares usage_from, `
        + `and without the flag the CLI prints prose and the seat reports no tokens at all`,
      );
      assert.ok(
        Object.prototype.hasOwnProperty.call(KIND_FOR_FORMAT, format),
        `${agent.id}.${name} asks for --output-format ${format}, which this check does not know. `
        + `Add it to KIND_FOR_FORMAT with the parseCliUsage kind it implies.`,
      );
      assert.equal(
        KIND_FOR_FORMAT[format], agent.usage_from.kind,
        `${agent.id}.${name} asks for '${format}' but usage_from.kind is '${agent.usage_from.kind}'`,
      );
    }
  }
});

test("a bundled CLI asking for structured output has a usage_from to unwrap it", () => {
  for (const agent of bundledRegistry.agents) {
    for (const [name, cmd] of cliCommands(agent)) {
      const format = requestedFormat(cmd);
      if (!format || KIND_FOR_FORMAT[format] == null) continue; // text, or unknown-and-caught above
      assert.ok(
        agent.usage_from,
        `${agent.id}.${name} asks for '${format}' but the entry declares no usage_from — `
        + `nothing unwraps the envelope, so the caller's answer is the raw JSON`,
      );
    }
  }
});

test("every bundled usage_from actually parses through the real interpreter", () => {
  // The strongest half of the check: the declared paths are fed to the module
  // that will read them. A typo in `usage.input_tokens`, an `event` that names a
  // type the envelope never carries, a kind the interpreter does not implement —
  // all of them return null here exactly as they would in production, where the
  // only symptom is a token count that quietly stays null.
  for (const agent of bundledRegistry.agents) {
    const spec = agent.usage_from;
    if (!spec) continue;
    assert.ok(
      spec.tokens_in || spec.tokens_out,
      `${agent.id}: a usage_from naming neither tokens_in nor tokens_out can never produce a number`,
    );

    // Build the smallest envelope the spec describes, then hand it back.
    const node = {};
    const put = (dotted, value) => {
      if (!dotted) return;
      const keys = String(dotted).split(".");
      let cur = node;
      for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {});
      cur[keys.at(-1)] = value;
    };
    put(spec.tokens_in, 11);
    put(spec.tokens_out, 22);
    put(spec.cost_usd, 0.5);
    put(spec.cache_read, 33);
    put(spec.cache_write, 44);
    if (spec.text) put(spec.text, "ok");
    if (spec.event) node.type = spec.event;

    const stdout = spec.kind === "jsonl"
      ? `${JSON.stringify({ type: "other" })}\n${JSON.stringify(node)}\n`
      : JSON.stringify(spec.event ? [{ type: "other" }, node] : node);

    const parsed = parseCliUsage(stdout, spec);
    assert.ok(parsed, `${agent.id}: usage_from does not round-trip through parseCliUsage`);
    assert.equal(parsed.tokens_in, spec.tokens_in ? 11 : null, `${agent.id}: tokens_in path`);
    assert.equal(parsed.tokens_out, spec.tokens_out ? 22 : null, `${agent.id}: tokens_out path`);
    if (spec.text) assert.equal(parsed.text, "ok", `${agent.id}: text path`);
  }
});

// A spec fed an envelope BUILT FROM ITSELF round-trips by construction, so the
// test above cannot see a path that is merely wrong — `usage.inputTokens`
// instead of `usage.input_tokens`, an `event` naming a type the stream never
// emits. Only real output can settle that, so here is some, recorded rather than
// guessed: this is the envelope `claude --print --output-format json` actually
// produced, captured live on 2026-08-31 and quoted in agents.yaml beside the
// specs it justifies.
//
// Keyed by the binary, because the spec belongs to the CLI and not to the model
// behind it. A CLI with no recording here still gets the structural check above;
// the way to give it this one is to capture its output and add it.
const RECORDED_ENVELOPES = {
  claude: {
    stdout: JSON.stringify([
      { type: "system", subtype: "init", model: "claude-opus-5" },
      { type: "assistant", message: { content: [{ type: "text", text: "Ok" }] } },
      {
        type: "result",
        subtype: "success",
        result: "Ok",
        // Re-captured 2026-09-01 against the live CLI. `cache_creation` is the
        // half that was missing: input_tokens is 10 of the 37,789 tokens this
        // request actually processed, so a spec that reads only that field
        // reports 0.03% of the input and the seat looks idle.
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 16104,
          cache_read_input_tokens: 21675,
          output_tokens: 315,
          output_tokens_details: { thinking_tokens: 307 },
        },
        total_cost_usd: 0.0377,
      },
    ]),
    expect: { text: "Ok", tokens_in: 10, tokens_out: 315, cache_read: 21675, cache_write: 16104, cost_usd: 0.0377 },
  },
};

test("every bundled usage_from parses the CLI output that was actually recorded", () => {
  let checked = 0;
  for (const agent of bundledRegistry.agents) {
    if (!agent.usage_from) continue;
    for (const [name, cmd] of cliCommands(agent)) {
      const tokens = new Set(cmd.split(/\s+/));
      const binary = Object.keys(RECORDED_ENVELOPES).find((b) => tokens.has(b));
      if (!binary) continue;
      const { stdout, expect } = RECORDED_ENVELOPES[binary];
      const parsed = parseCliUsage(stdout, agent.usage_from);
      assert.ok(parsed, `${agent.id}.${name}: usage_from does not parse recorded ${binary} output`);
      for (const [field, want] of Object.entries(expect)) {
        assert.equal(parsed[field], want, `${agent.id}.${name}: ${field} from recorded ${binary} output`);
      }
      checked++;
    }
  }
  // If the entries these were written for ever lose their commands, this test
  // would pass by checking nothing at all.
  assert.ok(checked > 0, "no bundled entry matched a recorded envelope — the fixture has gone stale");
});
