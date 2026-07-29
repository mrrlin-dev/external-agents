import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveFileContext } from "./dispatch.js";

test("resolveFileContext returns empty string for empty/null input", () => {
  assert.equal(resolveFileContext([], "."), "");
  assert.equal(resolveFileContext(null, "."), "");
  assert.equal(resolveFileContext(undefined, "."), "");
});

test("resolveFileContext reads a full file and wraps it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "hello.txt"), "line1\nline2\nline3");
    const result = resolveFileContext([{ path: "hello.txt" }], dir);
    assert.ok(result.includes("=== ATTACHED FILE CONTEXT ==="));
    assert.ok(result.includes("--- FILE: hello.txt ---"));
    assert.ok(result.includes("line1\nline2\nline3"));
    assert.ok(result.includes("--- END FILE ---"));
    assert.ok(result.includes("=== END FILE CONTEXT ==="));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext respects line ranges", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "code.js"), "a\nb\nc\nd\ne\nf");
    const result = resolveFileContext([{ path: "code.js", lines: "2-4" }], dir);
    assert.ok(result.includes("(lines 2-4)"));
    assert.ok(result.includes("2\tb"));
    assert.ok(result.includes("3\tc"));
    assert.ok(result.includes("4\td"));
    assert.ok(!result.includes("1\ta"));
    assert.ok(!result.includes("5\te"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext uses label when provided", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "x.ts"), "export const x = 1;");
    const result = resolveFileContext([{ path: "x.ts", label: "main export" }], dir);
    assert.ok(result.includes("--- FILE: main export ---"));
    assert.ok(!result.includes("--- FILE: x.ts ---"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext handles missing files gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    const result = resolveFileContext([{ path: "nope.txt" }], dir);
    assert.ok(result.includes("outside basedir, skipped") || result.includes("unreadable"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext handles multiple files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "a.ts"), "const a = 1;");
    fs.writeFileSync(path.join(dir, "b.ts"), "const b = 2;");
    const result = resolveFileContext([{ path: "a.ts" }, { path: "b.ts" }], dir);
    assert.ok(result.includes("--- FILE: a.ts ---"));
    assert.ok(result.includes("--- FILE: b.ts ---"));
    assert.ok(result.includes("const a = 1;"));
    assert.ok(result.includes("const b = 2;"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext blocks ../traversal outside basedir", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-parent-"));
  const child = path.join(parent, "sub");
  fs.mkdirSync(child);
  try {
    fs.writeFileSync(path.join(parent, "secret.txt"), "password123");
    const result = resolveFileContext([{ path: "../secret.txt" }], child);
    assert.ok(result.includes("outside basedir, skipped"));
    assert.ok(!result.includes("password123"));
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveFileContext blocks absolute paths outside basedir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    const outsidePath = path.join(os.tmpdir(), "ea-outside-sentinel-" + process.pid + ".txt");
    fs.writeFileSync(outsidePath, "exfiltrated");
    try {
      const result = resolveFileContext([{ path: outsidePath }], dir);
      assert.ok(result.includes("outside basedir, skipped"));
      assert.ok(!result.includes("exfiltrated"));
    } finally {
      fs.unlinkSync(outsidePath);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext skips entries without path", () => {
  const result = resolveFileContext([null, {}, { notPath: "x" }], ".");
  assert.equal(result, "");
});

test("resolveFileContext handles malformed lines gracefully", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "f.txt"), "hello");
    const result = resolveFileContext([{ path: "f.txt", lines: "abc" }], dir);
    assert.ok(result.includes("malformed lines"));
    assert.ok(result.includes("hello"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext handles reversed range (end < start)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb\nc");
    const result = resolveFileContext([{ path: "f.txt", lines: "3-1" }], dir);
    assert.ok(result.includes("invalid range"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveFileContext handles out-of-range lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ea-files-test-"));
  try {
    fs.writeFileSync(path.join(dir, "f.txt"), "a\nb");
    const result = resolveFileContext([{ path: "f.txt", lines: "100-200" }], dir);
    assert.ok(result.includes("out of range"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
