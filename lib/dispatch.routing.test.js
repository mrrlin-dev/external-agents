import assert from "node:assert/strict";
import { test } from "node:test";

import { selectTransport } from "./dispatch.js";

const both = {
  id: "both",
  transports: {
    generate_new: { url: "https://example.invalid/v1/chat/completions" },
    edit_exists: { cmd: "example-cli" },
  },
};

test("selectTransport respects an explicit generate_new override", () => {
  assert.equal(selectTransport(both, { transport: "generate_new", cwd: "/repo" }), "generate_new");
});

test("selectTransport respects an explicit edit_exists override", () => {
  assert.equal(selectTransport(both, { transport: "edit_exists" }), "edit_exists");
});

test("selectTransport rejects explicit transports that are not declared", () => {
  const generateOnly = { id: "generate-only", transports: { generate_new: both.transports.generate_new } };
  assert.throws(() => selectTransport(generateOnly, { transport: "edit_exists" }), /not declared/);
  assert.throws(
    () => selectTransport({ id: "edit-only", transports: { edit_exists: both.transports.edit_exists } }, { transport: "generate_new" }),
    /not declared/,
  );
});

test("selectTransport prefers edit_exists when cwd is supplied", () => {
  assert.equal(selectTransport(both, { cwd: "/repo" }), "edit_exists");
});

test("selectTransport falls back to generate_new when cwd agent has no edit_exists", () => {
  assert.equal(
    selectTransport({ id: "generate-only", transports: { generate_new: both.transports.generate_new } }, { cwd: "/repo" }),
    "generate_new",
  );
});

test("selectTransport defaults to generate_new without cwd", () => {
  assert.equal(selectTransport(both), "generate_new");
});

test("selectTransport falls back to edit_exists when generate_new is absent", () => {
  assert.equal(
    selectTransport({ id: "edit-only", transports: { edit_exists: both.transports.edit_exists } }),
    "edit_exists",
  );
});

test("selectTransport rejects an agent with no known transport", () => {
  assert.throws(() => selectTransport({ id: "none", transports: {} }), /no known transport/);
});

test("selectTransport uses a declared read_only command when requested", () => {
  const withReadOnly = {
    id: "with-ro",
    transports: { edit_exists: { cmd: "example-cli" }, read_only: { cmd: "example-cli --safe" } },
  };
  assert.equal(selectTransport(withReadOnly, { transport: "read_only", cwd: "/repo" }), "read_only");
});

test("selectTransport treats generate_new as read_only by construction", () => {
  const generateOnly = { id: "generate-only", transports: { generate_new: both.transports.generate_new } };
  assert.equal(selectTransport(generateOnly, { transport: "read_only" }), "generate_new");
});

test("selectTransport refuses to fall back to a write-capable edit_exists for a read_only request", () => {
  const editOnly = { id: "edit-only-no-ro", transports: { edit_exists: { cmd: "example-cli" } } };
  assert.throws(
    () => selectTransport(editOnly, { transport: "read_only", cwd: "/repo" }),
    /neither 'read_only' nor 'generate_new'/,
  );
});
