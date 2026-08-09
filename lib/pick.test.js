import assert from "node:assert/strict";
import { test } from "node:test";

import { pickAgents } from "./pick.js";

const registry = {
  agents: [
    { id: "http-only", provider: "p1", transports: { generate_new: { url: "https://example.invalid" } } },
    { id: "edit-only", provider: "p2", transports: { edit_exists: { cmd: "example-cli" } } },
    {
      id: "edit-and-ro",
      provider: "p3",
      transports: {
        edit_exists: { cmd: "example-cli --write", effort_levels: ["low", "high"] },
        read_only: { cmd: "example-cli --safe" },
      },
    },
  ],
};

test("pickAgents --transport read_only matches an implicit generate_new entry", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(picked.includes("http-only"));
});

test("pickAgents --transport read_only matches an entry with a declared read_only command", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(picked.includes("edit-and-ro"));
});

test("pickAgents --transport read_only excludes an edit_exists-only entry with no read_only command", () => {
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only" } });
  assert.ok(!picked.includes("edit-only"));
});

test("pickAgents --transport read_only --effort checks the transport that actually satisfies read_only", () => {
  // edit-and-ro's read_only cmd declares no effort_levels (only its edit_exists
  // cmd does) — a naive check of literal "read_only" would wrongly exclude it.
  const picked = pickAgents(registry, {}, { n: 3, filter: { transport: "read_only", effort: "high" } });
  assert.ok(!picked.includes("edit-and-ro"), "read_only cmd itself declares no effort_levels");
});
