import test from "node:test";
import assert from "node:assert/strict";
import { authorized } from "../server.mjs";

test("requires the configured worker token", () => {
  const env = { LLM_WORKER_TOKEN: "secret-token" };
  assert.equal(authorized({}, env), false);
  assert.equal(authorized({ authorization: "Bearer wrong" }, env), false);
  assert.equal(authorized({ authorization: "Bearer secret-token" }, env), true);
  assert.equal(authorized({ "x-spmt-ai-token": "secret-token" }, env), true);
});

test("stays closed when the worker token is unset", () => {
  assert.equal(authorized({ authorization: "Bearer anything" }, {}), false);
});
