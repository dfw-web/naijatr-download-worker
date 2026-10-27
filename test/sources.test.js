import test from "node:test";
import assert from "node:assert/strict";
import { loadSources } from "../lib/sources.js";

const ok = { url: "https://a.example/m.m3u8", hosts: ["a.example", "cdn.example"], authorization: "licensed" };

test("loads approved sources", () => {
  const s = loadSources(JSON.stringify({ movie: ok }));
  assert.deepEqual(s.get("movie").hosts, ["a.example", "cdn.example"]);
  assert.equal(loadSources(undefined).size, 0);
});

test("rejects incomplete or loose source config", () => {
  for (const bad of [
    { ...ok, hosts: ["cdn.example"] },
    { ...ok, hosts: ["a.example", "*.example"] },
    { ...ok, hosts: "a.example" },
    { ...ok, authorization: " " },
    { ...ok, url: "not a url" },
  ]) assert.throws(() => loadSources(JSON.stringify({ x: bad })), JSON.stringify(bad));
  assert.throws(() => loadSources("[]"));
  assert.throws(() => loadSources("{"));
});
