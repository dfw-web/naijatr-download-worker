import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { safeGet, fetchText, fetchToFile, SourceError } from "./net.js";
import { isPlaylist, isMaster, parseMaster, pickVariant, localizeMedia } from "./hls.js";

const FILE_EXT = /\.(mp4|m4v|mkv|mov|webm)$/i;

/** What a URL is: a direct video file or an HLS playlist (with its qualities and audio tracks). */
export async function resolveSource(raw, policy, opts = {}) {
  const { res, url } = await safeGet(raw, policy, opts);
  const type = String(res.headers["content-type"] || "").toLowerCase();
  const it = res[Symbol.asyncIterator]();
  const first = (await it.next()).value || Buffer.alloc(0);
  if (!isPlaylist(first.toString("utf8", 0, 16))) {
    res.destroy();
    const ext = (new URL(url).pathname.match(FILE_EXT)?.[1] || "mp4").toLowerCase();
    if (!type.startsWith("video/") && !type.startsWith("application/octet-stream") && !FILE_EXT.test(new URL(url).pathname))
      throw new SourceError(`not a video (content-type ${type || "none"})`, 422);
    const size = parseInt(res.headers["content-length"], 10) || null;
    return { type: "file", url, ext, size, contentType: type };
  }
  const chunks = [first];
  let size = first.length;
  for (let c = await it.next(); !c.done; c = await it.next()) {
    size += c.value.length;
    if (size > 5 * 1024 * 1024) { res.destroy(); throw new SourceError("playlist too large", 502); }
    chunks.push(c.value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!isMaster(text)) return { type: "hls", url, variants: [{ id: "0", uri: url, bandwidth: 0, width: 0, height: 0, codecs: "", audioGroup: null }], audio: [], mediaText: text };
  return { type: "hls", url, ...parseMaster(text, url) };
}

/** The public shape of a resolved source (no internal playlist text). */
export const describe = (s) => s.type === "file"
  ? { type: "file", ext: s.ext, size: s.size }
  : { type: "hls", variants: s.variants.map(({ id, width, height, bandwidth, codecs, audioGroup }) => ({ id, width, height, bandwidth, codecs, audioGroup })), audio: s.audio.map(({ groupId, name, language, default: d }) => ({ groupId, name, language, default: d })) };

async function downloadAll(items, dir, policy, job, signal, concurrency = 4) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await fetchToFile(item.url, path.join(dir, item.name), policy, job.budget, { signal });
      job.progress.done++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
}

function ffmpeg(bin, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { cwd, signal, stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    p.on("error", reject);
    p.on("close", (code, sig) => (code === 0 ? resolve() : reject(new SourceError(`ffmpeg failed: ${err.trim().split("\n").pop() || (sig ? `killed by ${sig}` : `exit ${code}`)}`, 502))));
  });
}

const HLS_IN = ["-allowed_extensions", "ALL", "-protocol_whitelist", "file,crypto"];

export function sanitizeName(name, ext) {
  const base = String(name || "video").replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[^\w .()-]+/g, "").trim().slice(0, 120) || "video";
  return `${base}.${ext}`;
}

export function createJobs({ ffmpegPath, tmpRoot = path.join(os.tmpdir(), "naijatr-dl"), maxJobs = 2, maxBytes = 3 * 1024 ** 3, ttlMs = 60 * 60 * 1000, timeoutMs = 45 * 60 * 1000 }) {
  const jobs = new Map();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const running = () => [...jobs.values()].filter((j) => !["ready", "error"].includes(j.state)).length;

  async function cleanup(job, keepOutput) {
    if (!job.dir) return;
    if (keepOutput && job.file) {
      for (const f of await fsp.readdir(job.dir)) if (path.join(job.dir, f) !== job.file) await fsp.rm(path.join(job.dir, f), { recursive: true, force: true });
    } else {
      await fsp.rm(job.dir, { recursive: true, force: true });
      job.file = null;
    }
  }

  async function run(job, req) {
    const { policy } = req;
    const signal = job.abort.signal;
    job.dir = await fsp.mkdtemp(path.join(tmpRoot, "job-"));
    job.state = "resolving";
    // req.url is a URL or a function finding one (a player page's media).
    const src = await resolveSource(typeof req.url === "function" ? await req.url(signal) : req.url, policy, { signal });
    if (src.type === "file") {
      job.filename = sanitizeName(req.filename || path.basename(new URL(src.url).pathname), src.ext);
      job.progress.total = 1;
      job.state = "downloading";
      job.file = path.join(job.dir, `out.${src.ext}`);
      await fetchToFile(src.url, job.file, policy, job.budget, { signal });
      job.progress.done = 1;
      return;
    }
    const variant = pickVariant(src.variants, req.quality, req.variantId);
    job.variant = { id: variant.id, width: variant.width, height: variant.height, bandwidth: variant.bandwidth };
    const media = src.mediaText ? { text: src.mediaText, url: src.url } : await fetchText(variant.uri, policy, { signal });
    const video = localizeMedia(media.text, media.url, "v");
    const tracks = [];
    const seen = new Set();
    for (const a of src.audio) {
      if (a.groupId !== variant.audioGroup || !a.uri || seen.has(a.uri)) continue;
      seen.add(a.uri);
      const t = await fetchText(a.uri, policy, { signal });
      tracks.push({ ...localizeMedia(t.text, t.url, `a${tracks.length}_`), language: a.language, name: a.name });
    }
    job.audioTracks = tracks.map((t) => t.language || t.name);
    const all = [...video.downloads, ...tracks.flatMap((t) => t.downloads)];
    job.progress.total = all.length;
    job.state = "downloading";
    await downloadAll(all, job.dir, policy, job, signal);
    await fsp.writeFile(path.join(job.dir, "v.m3u8"), video.playlist);
    const args = ["-hide_banner", "-loglevel", "error", "-y", ...HLS_IN, "-i", "v.m3u8"];
    for (const [i, t] of tracks.entries()) {
      await fsp.writeFile(path.join(job.dir, `a${i}.m3u8`), t.playlist);
      args.push(...HLS_IN, "-i", `a${i}.m3u8`);
    }
    args.push("-map", "0:v?");
    if (!tracks.length) args.push("-map", "0:a?");
    tracks.forEach((t, i) => {
      args.push("-map", `${i + 1}:a:0`);
      if (t.language) args.push(`-metadata:s:a:${i}`, `language=${t.language}`);
    });
    args.push("-c", "copy", "-movflags", "+faststart", "out.mp4");
    job.state = "remuxing";
    await ffmpeg(ffmpegPath, args, job.dir, signal);
    job.file = path.join(job.dir, "out.mp4");
    job.filename = sanitizeName(req.filename || path.basename(new URL(src.url).pathname), "mp4");
  }

  function start(req) {
    if (running() >= maxJobs) throw new SourceError("worker is busy, try again shortly", 429);
    const job = {
      id: crypto.randomUUID(), token: crypto.randomBytes(24).toString("base64url"),
      state: "queued", progress: { done: 0, total: 0 }, budget: { left: maxBytes },
      createdAt: Date.now(), abort: new AbortController(), dir: null, file: null,
    };
    jobs.set(job.id, job);
    const timer = setTimeout(() => job.abort.abort(new SourceError("download timed out", 504)), timeoutMs);
    run(job, req)
      .then(async () => { await cleanup(job, true); job.state = "ready"; })
      .catch(async (e) => {
        job.state = "error";
        job.error = signal_reason(job) || (e instanceof SourceError ? e.message : "download failed");
        if (!(e instanceof SourceError)) console.error("job", job.id, e);
        await cleanup(job, false);
      })
      .finally(() => { clearTimeout(timer); job.finishedAt = Date.now(); });
    return job;
  }

  const signal_reason = (job) => (job.abort.signal.aborted ? String(job.abort.signal.reason?.message || "cancelled") : null);

  async function remove(job) {
    job.abort.abort(new SourceError("cancelled"));
    jobs.delete(job.id);
    await cleanup(job, false);
  }

  const sweep = setInterval(() => {
    for (const job of jobs.values()) if (Date.now() - job.createdAt > ttlMs + timeoutMs || (job.finishedAt && Date.now() - job.finishedAt > ttlMs)) remove(job);
  }, 60 * 1000);
  sweep.unref();

  const status = (job) => ({
    id: job.id, state: job.state, progress: job.progress, error: job.error,
    variant: job.variant, audioTracks: job.audioTracks, filename: job.filename,
    bytes: job.state === "ready" && job.file ? fs.statSync(job.file).size : undefined,
  });

  return { start, get: (id) => jobs.get(id), remove, status, close: () => clearInterval(sweep), jobs };
}
