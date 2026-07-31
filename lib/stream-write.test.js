import assert from "node:assert/strict";
import { test } from "node:test";
import { Writable } from "node:stream";

import { writeText } from "./stream-write.js";

test("writeText writes the full payload", async () => {
  let output = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      output += chunk.toString();
      cb();
    },
  });

  await writeText(stream, "hello\nworld\n");
  assert.equal(output, "hello\nworld\n");
});

test("writeText is a no-op for empty text", async () => {
  let writes = 0;
  const stream = new Writable({
    write(_chunk, _enc, cb) {
      writes++;
      cb();
    },
  });

  await writeText(stream, "");
  assert.equal(writes, 0);
});
