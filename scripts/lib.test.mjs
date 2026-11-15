import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, isSourceFile, manifestProblem, triage } from "./lib.mjs";

const minimal = { name: "Hello", description: "Says hello.", icon: "icon.svg", page: "panel.html" };

test("a minimal panel file is valid", () => {
  assert.equal(manifestProblem(minimal), null);
});

test("a tools package must be pinned, so the checked code is the code that runs", () => {
  assert.equal(manifestProblem({ ...minimal, tools: { npx: "hello-mcp@1.2.3" } }), null);
  assert.equal(manifestProblem({ ...minimal, tools: { npx: "@me/hello-mcp@1.2.3-beta.1" } }), null);
  assert.notEqual(manifestProblem({ ...minimal, tools: { npx: "hello-mcp" } }), null);
  assert.notEqual(manifestProblem({ ...minimal, tools: { npx: "hello-mcp@latest" } }), null);
  assert.notEqual(manifestProblem({ ...minimal, tools: { npx: "hello-mcp@^1.2.3" } }), null);
});

test("sites are https or wss origins only", () => {
  assert.equal(manifestProblem({ ...minimal, sites: ["https://api.example.com", "wss://*.example.com:8443"] }), null);
  for (const site of ["http://example.com", "https://example.com/path", "https://*", "example.com"]) {
    assert.notEqual(manifestProblem({ ...minimal, sites: [site] }), null, site);
  }
});

test("paths may not leave the repository", () => {
  assert.notEqual(manifestProblem({ ...minimal, page: "../x.html" }), null);
  assert.notEqual(manifestProblem({ ...minimal, icon: "/etc/icon.svg" }), null);
});

test("a need says how to find it: an app or a command", () => {
  const get = "https://example.com";
  assert.equal(manifestProblem({ ...minimal, needs: [{ name: "Inspiration", app: "com.whykirbyy.Inspiration", get }] }), null);
  assert.equal(manifestProblem({ ...minimal, needs: [{ name: "ffmpeg", command: "ffmpeg", get }] }), null);
  assert.notEqual(manifestProblem({ ...minimal, needs: [{ name: "Nothing", get }] }), null);
});

test("unknown fields are refused with a sentence saying where", () => {
  assert.match(manifestProblem({ ...minimal, permissions: ["files"] }), /must NOT have additional properties/);
});

test("a commit is checked once: listed stays, refused stays refused", () => {
  const listed = [{ repository: "a/b", commit: "c1" }];
  const removed = [{ repository: "a/b", commit: "c2" }];
  assert.equal(triage("a/b", "c1", listed, removed), "same");
  assert.equal(triage("a/b", "c2", listed, removed), "refused");
  assert.equal(triage("a/b", "c3", listed, removed), "check");
});

test("the fingerprint ignores file order and changes with any byte", () => {
  const a = fingerprint([["x", Buffer.from("1")], ["y", Buffer.from("2")]]);
  assert.equal(a, fingerprint([["y", Buffer.from("2")], ["x", Buffer.from("1")]]));
  assert.notEqual(a, fingerprint([["x", Buffer.from("1")], ["y", Buffer.from("3")]]));
});

test("lockfiles and dependencies are not read as the server's source", () => {
  assert.equal(isSourceFile("server.mjs"), true);
  assert.equal(isSourceFile("node_modules/x/index.js"), false);
  assert.equal(isSourceFile("package-lock.json"), false);
  assert.equal(isSourceFile("icon.png"), false);
});
