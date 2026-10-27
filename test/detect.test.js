import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpegPath from "ffmpeg-static";
import { createApp } from "../lib/app.js";
import { createJobs } from "../lib/jobs.js";
import { detectMedia, isMediaRequest, pinnedHosts } from "../lib/detect.js";
import { hostMatcher, makePolicy } from "../lib/net.js";
import { checkSource, loadSources, playerUrl } from "../lib/sources.js";

// A test player (our own page and generated media), like an embed page that loads HLS.
const fx = fs.mkdtempSync(path.join(os.tmpdir(), "dlw-player-"));
execFileSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-c:v", "libx264", "-c:a", "aac", "-shortest", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "s_%02d.ts", "stream.m3u8"], { cwd: fx });

// Must never be reached: stands in for a private address the page tries.
let forbiddenHits = 0;
const forbidden = http.createServer((req, res) => { forbiddenHits++; res.end("secret"); });
await new Promise((r) => forbidden.listen(0, "127.0.0.2", r));
const forbiddenUrl = `http://127.0.0.2:${forbidden.address().port}/latest/meta-data/`;

const page = (body) => `<!doctype html><title>Test player</title><body>${body}</body>`;
const player = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  // Loads HLS straight away, after poking a forbidden address (as an ad script might).
  if (pathname.startsWith("/embed/movie/")) return res.end(page(`<script>fetch(${JSON.stringify(forbiddenUrl)}).catch(() => {}); fetch("/stream.m3u8?id=${pathname.split("/").pop()}");</script>`));
  // Starts only when tapped.
  if (pathname.startsWith("/embed/tv/")) return res.end(page(`<button style="position:fixed;inset:0" onclick="fetch('/stream.m3u8')">Play</button>`));
  if (pathname === "/empty") return res.end(page("no player here"));
  const f = path.join(fx, path.basename(pathname));
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => player.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${player.address().port}`;

// Tests may reach the local test player only.
const policy = { allowHost: hostMatcher("127.0.0.1"), allowIp: (ip) => ip === "127.0.0.1", allowPort: () => true };
const sources = loadSources(JSON.stringify({
  "test-player": { player: { movie: `${origin}/embed/movie/{tmdbId}`, tv: `${origin}/embed/tv/{tmdbId}/{season}/{episode}` }, hosts: ["127.0.0.1"], authorization: "our own test player and generated test media" },
  "empty-player": { player: { movie: `${origin}/empty` }, hosts: ["127.0.0.1"], authorization: "test" },
}));
const jobs = createJobs({ ffmpegPath, tmpRoot: path.join(os.tmpdir(), "dlw-player-jobs") });
const server = createApp({ apiKey: "k", sources, jobs, policyFor: () => policy, detect: (url, o) => detectMedia(url, { ...o, timeoutMs: 15000 }) }).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const api = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: "Bearer k", "content-type": "application/json" };
const post = (p, body) => fetch(api + p, { method: "POST", headers: auth, body: JSON.stringify(body) });

test.after(() => { server.close(); player.close(); forbidden.close(); jobs.close(); fs.rmSync(fx, { recursive: true, force: true }); });

test("player sources: templates, exact hosts, numbers only", () => {
  const s = checkSource("p", { player: { movie: "https://p.example/embed/movie/{tmdbId}", tv: "https://p.example/tv/{tmdbId}/{season}/{episode}" }, hosts: ["p.example"], authorization: "licence" });
  assert.equal(playerUrl(s, { tmdbId: "550", type: "movie" }), "https://p.example/embed/movie/550");
  assert.equal(playerUrl(s, { tmdbId: 1399, type: "tv", season: 1, episode: 2 }), "https://p.example/tv/1399/1/2");
  assert.throws(() => playerUrl(s, { tmdbId: "550/../../x", type: "movie" }), /tmdbId must be a number/);
  assert.throws(() => playerUrl(s, { tmdbId: "1", type: "tv", season: "1" }), /episode must be a number/);
  assert.throws(() => checkSource("p", { player: { movie: "https://other.example/{tmdbId}" }, hosts: ["p.example"], authorization: "x" }), /exact hosts/);
  assert.throws(() => checkSource("p", { player: { movie: "https://p.example/{tmdbId}" }, hosts: ["p.example"] }), /authorization/);
});

test("Streambert's media test, plus plain video files", () => {
  assert.ok(isMediaRequest("https://cdn.example/master.m3u8?token=1", "xhr"));
  assert.ok(isMediaRequest("https://cdn.example/movie.mp4", "media"));
  assert.ok(!isMediaRequest("https://cdn.example/app.js", "script"));
  // A player page naming its playlist in the query is not the playlist.
  assert.ok(!isMediaRequest("https://player.example/demo/?src=https%3A%2F%2Fcdn.example%2Fa.m3u8", "document"));
  assert.ok(!isMediaRequest("https://player.example/api?src=a.m3u8", "xhr"));
});

test("DNS is pinned to public addresses; private ones are refused", async () => {
  const lookup = async (h) => (h === "ok.example" ? [{ address: "93.184.215.14", family: 4 }] : [{ address: "10.0.0.5", family: 4 }]);
  assert.equal(await pinnedHosts(["ok.example"], makePolicy("ok.example"), lookup), "MAP ok.example 93.184.215.14, MAP * ~NOTFOUND");
  await assert.rejects(pinnedHosts(["ok.example", "inside.example"], makePolicy("ok.example,inside.example"), lookup), /address not allowed: inside.example/);
});

test("the caller can't send the player URL", async () => {
  const res = await post("/resolve", { sourceId: "test-player", tmdbId: "550", playerUrl: "https://evil.example/" });
  assert.equal(res.status, 400);
  assert.equal((await post("/resolve", { sourceId: "test-player", tmdbId: "../x" })).status, 400);
});

test("detects the player's HLS, never reaching a forbidden address", async () => {
  const res = await post("/resolve", { sourceId: "test-player", tmdbId: "550" });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.type, "hls");
  assert.equal(body.variants.length, 1);
  assert.equal(forbiddenHits, 0);
});

test("a tap-to-play TV player downloads to a playable MP4", async () => {
  const start = await (await post("/download/start", { sourceId: "test-player", type: "tv", tmdbId: "1399", season: 1, episode: 2, filename: "show-s01e02" })).json();
  let st;
  for (let i = 0; i < 400 && !["ready", "error"].includes(st?.state); i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = await (await fetch(api + start.status, { headers: auth })).json();
  }
  assert.equal(st.state, "ready", st.error);
  const res = await fetch(api + start.file);
  assert.equal(res.status, 200);
  const out = path.join(fx, "out.mp4");
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  const info = execFileSync(ffmpegPath, ["-hide_banner", "-i", out, "-f", "null", "-"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).toString();
  assert.equal(st.filename, "show-s01e02.mp4");
  assert.ok(fs.statSync(out).size > 10000, info);
});

test("a page with no media times out cleanly", async () => {
  const res = await post("/resolve", { sourceId: "empty-player" });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "no media found on the player page" });
});
