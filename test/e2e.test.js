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
import { hostMatcher } from "../lib/net.js";

// Fixtures: two video-only HLS qualities, a separate audio playlist, a master, and an MP4.
const fx = fs.mkdtempSync(path.join(os.tmpdir(), "dlw-fx-"));
const ff = (...a) => execFileSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...a], { cwd: fx });
for (const [w, h] of [[640, 360], [426, 240]]) ff("-f", "lavfi", "-i", `testsrc=size=${w}x${h}:rate=25:duration=3`, "-c:v", "libx264", "-g", "25", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", `v${h}_%02d.ts`, `v${h}.m3u8`);
ff("-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-c:a", "aac", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "a_%02d.ts", "a.m3u8");
ff("-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", "clip.mp4");
fs.writeFileSync(path.join(fx, "master.m3u8"), [
  "#EXTM3U",
  '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="eng",DEFAULT=YES,URI="a.m3u8"',
  '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,AUDIO="aud"',
  "v360.m3u8",
  '#EXT-X-STREAM-INF:BANDWIDTH=400000,RESOLUTION=426x240,AUDIO="aud"',
  "v240.m3u8",
].join("\n"));
fs.writeFileSync(path.join(fx, "broken.m3u8"), "#EXTM3U\n#EXTINF:1,\nmissing.ts\n#EXT-X-ENDLIST\n");

const source = http.createServer((req, res) => {
  if (req.url === "/redirect-out") return res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" }).end();
  if (req.url === "/redirect-in") return res.writeHead(302, { location: "/clip.mp4" }).end();
  const f = path.join(fx, path.basename(req.url));
  if (!fs.existsSync(f)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": f.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : f.endsWith(".mp4") ? "video/mp4" : "video/mp2t" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => source.listen(0, "127.0.0.1", r));
const src = `http://127.0.0.1:${source.address().port}`;

// Tests may reach the local fixture server only; everything else stays blocked.
const policy = { allowHost: hostMatcher("127.0.0.1"), allowIp: (ip) => ip === "127.0.0.1", allowPort: () => true };
const tmpRoot = path.join(os.tmpdir(), "dlw-test-jobs");
const jobs = createJobs({ policy, ffmpegPath, tmpRoot });
const server = createApp({ apiKey: "k", policy, jobs }).listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const api = `http://127.0.0.1:${server.address().port}`;
const auth = { authorization: "Bearer k", "content-type": "application/json" };
const post = (p, body, headers = auth) => fetch(api + p, { method: "POST", headers, body: JSON.stringify(body) });

test.after(() => { server.close(); source.close(); jobs.close(); fs.rmSync(fx, { recursive: true, force: true }); });

async function waitFor(start) {
  let st;
  for (let i = 0; i < 300 && !["ready", "error"].includes(st?.state); i++) {
    await new Promise((r) => setTimeout(r, 100));
    st = await (await fetch(api + start.status, { headers: auth })).json();
  }
  return st;
}

async function download(body) {
  const start = await (await post("/download/start", body)).json();
  const st = await waitFor(start);
  assert.equal(st.state, "ready", st.error);
  const res = await fetch(api + start.file);
  assert.equal(res.status, 200);
  const out = path.join(fx, `${start.id}-${st.filename}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  await new Promise((r) => setTimeout(r, 200));
  return { start, st, out, disposition: res.headers.get("content-disposition") };
}

/** ffmpeg's stream summary, after checking every frame decodes. */
function probe(file) {
  execFileSync(ffmpegPath, ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"]);
  try { execFileSync(ffmpegPath, ["-hide_banner", "-i", file], { stdio: ["ignore", "ignore", "pipe"] }); } catch (e) { return String(e.stderr); }
  return "";
}

test("requires the API key and the job token", async () => {
  assert.equal((await post("/resolve", { url: `${src}/clip.mp4` }, { "content-type": "application/json" })).status, 401);
  assert.equal((await fetch(`${api}/download/file/nope?token=x`)).status, 404);
});

test("resolve lists HLS qualities and audio", async () => {
  const r = await (await post("/resolve", { url: `${src}/master.m3u8` })).json();
  assert.equal(r.type, "hls");
  assert.deepEqual(r.variants.map((v) => v.height), [360, 240]);
  assert.equal(r.audio[0].language, "eng");
});

test("title lookups fail until a resolver is written", async () => {
  const res = await post("/resolve", { tmdbId: 603 });
  assert.equal(res.status, 501);
  assert.equal((await post("/download/start", { tmdbId: 603, type: "tv", season: 1, episode: 1 })).status, 501);
});

test("SSRF: blocked hosts, schemes and redirects", async () => {
  for (const url of ["http://localhost:1/", "file:///etc/passwd", "http://169.254.169.254/", `${src}/redirect-out`]) {
    const res = await post("/resolve", { url });
    assert.ok(res.status >= 400 && res.status < 500, `${url} -> ${res.status}`);
  }
  assert.equal((await (await post("/resolve", { url: `${src}/redirect-in` })).json()).type, "file");
});

test("HLS master: picks the asked quality, keeps the audio, plays, cleans up", async () => {
  const { st, out, disposition, start } = await download({ url: `${src}/master.m3u8`, quality: 240, filename: "My Movie" });
  assert.equal(st.variant.height, 240);
  assert.deepEqual(st.audioTracks, ["eng"]);
  assert.match(disposition, /My Movie\.mp4/);
  const info = probe(out);
  assert.match(info, /Video: h264.*426x240/);
  assert.match(info, /Audio: aac/);
  assert.equal(jobs.get(start.id), undefined);
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("HLS best quality by default", async () => {
  const { st, out } = await download({ url: `${src}/master.m3u8` });
  assert.equal(st.variant.height, 360);
  assert.match(probe(out), /640x360/);
});

test("direct MP4 streams through unchanged", async () => {
  const { out } = await download({ url: `${src}/clip.mp4` });
  assert.deepEqual(fs.readFileSync(out), fs.readFileSync(path.join(fx, "clip.mp4")));
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});

test("failed jobs remove their temp files", async () => {
  const st = await waitFor(await (await post("/download/start", { url: `${src}/broken.m3u8` })).json());
  assert.equal(st.state, "error");
  assert.deepEqual(fs.readdirSync(tmpRoot), []);
});
