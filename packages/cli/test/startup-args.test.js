import test from "node:test";
import assert from "node:assert/strict";
import { parseStartupArgs, validateStartupArgs } from "../src/startup-args.js";

test("parses the simple one-argument-per-line format", () => {
  assert.deepEqual(parseStartupArgs("--host 127.0.0.1\n--port\n3080\n"), ["--host", "127.0.0.1", "--port", "3080"]);
});

test("ignores blank lines and whole-line comments", () => {
  assert.deepEqual(parseStartupArgs("\n# comment\n--port 3080\n\n"), ["--port", "3080"]);
});

test("keeps # inside tokens", () => {
  assert.deepEqual(parseStartupArgs("--url http://127.0.0.1/#/settings\n"), ["--url", "http://127.0.0.1/#/settings"]);
});

test("supports quoted tokens with spaces", () => {
  assert.deepEqual(parseStartupArgs('--persona "hello world"\n--name \'dsh boot\'\n'), [
    "--persona",
    "hello world",
    "--name",
    "dsh boot",
  ]);
});

test("supports backslash escapes", () => {
  assert.deepEqual(parseStartupArgs(String.raw`--token a\ b\nc` + "\n"), ["--token", "a bnc"]);
});

test("rejects unterminated quotes", () => {
  assert.throws(() => parseStartupArgs('--name "open'), /unterminated/);
});

test("rejects launcher-owned flags and subcommands", () => {
  assert.throws(() => validateStartupArgs(["--profile", "tui"]), /launcher-owned/);
  assert.throws(() => validateStartupArgs(["plugin", "add"]), /subcommand/);
  assert.deepEqual(validateStartupArgs(["--port", "3080"]), ["--port", "3080"]);
});
