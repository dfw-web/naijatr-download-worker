import express from "express";
import crypto from "node:crypto";
import { SourceError, makePolicy } from "./net.js";
import { resolveSource, describe } from "./jobs.js";
import { checkSource, playerUrl } from "./sources.js";
import { detectMedia } from "./detect.js";
import { findSource } from "./resolver.js";

const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

// Callers name an approved source; they can never send a URL or host list.
const FIELDS = new Set(["sourceId", "tmdbId", "type", "season", "episode", "quality", "variantId", "filename"]);

export function createApp({ apiKey, sources, jobs, defaultSourceId = process.env.DEFAULT_DOWNLOAD_SOURCE_ID, policyFor = (hosts) => makePolicy(hosts.join(",")), detect = detectMedia }) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "8kb" }));

  app.get("/health", (req, res) => {
    res.json({ status: "ok", service: "naijatr-download-worker" });
  });

  const hasKey = (req) => Boolean(apiKey) && sameSecret(String(req.get("authorization") || ""), `Bearer ${apiKey}`);
  const requireKey = (req, res, next) => {
    if (!apiKey) return res.status(503).json({ error: "WORKER_API_KEY is not set" });
    if (!hasKey(req)) return res.status(401).json({ error: "unauthorized" });
    res.set("Cache-Control", "no-store");
    next();
  };
  // A configured sourceId, or a title reference handed to the resolver.
  const sourceFor = async (body) => {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((k) => !FIELDS.has(k))) throw new SourceError("unexpected fields; send a sourceId (URLs are not accepted)");
    if (body.type != null && body.type !== "movie" && body.type !== "tv") throw new SourceError("type must be movie or tv");
    let source;
    if (typeof body.sourceId === "string") {
      source = sources.get(body.sourceId);
      if (!source) throw new SourceError("unknown approved source", 404);
    } else if (body.tmdbId != null) {
      source = checkSource(`tmdb:${body.tmdbId}`, await findSource({ tmdbId: String(body.tmdbId), type: body.type === "tv" ? "tv" : "movie", season: body.season, episode: body.episode }, { sources, defaultSourceId }));
    } else {
      throw new SourceError("sourceId is required");
    }
    const policy = policyFor(source.hosts);
    if (!source.player) return { ...source, policy, mediaUrl: () => source.url };
    // A player page: the media URL is whatever the page loads.
    const page = playerUrl(source, { tmdbId: body.tmdbId, type: body.type === "tv" ? "tv" : "movie", season: body.season, episode: body.episode });
    return { ...source, policy, mediaUrl: (signal) => detect(page, { hosts: source.hosts, policy, signal }) };
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (!(e instanceof SourceError)) console.error(e);
    res.status(e instanceof SourceError ? e.status : 502).json({ error: e instanceof SourceError ? e.message : "source unreachable" });
  });

  app.post("/resolve", requireKey, wrap(async (req, res) => {
    const source = await sourceFor(req.body);
    res.json({ sourceId: source.id, attribution: source.attribution, ...describe(await resolveSource(await source.mediaUrl(), source.policy)) });
  }));

  app.post("/download/start", requireKey, wrap(async (req, res) => {
    const { quality, variantId, filename } = req.body;
    const source = await sourceFor(req.body);
    const job = jobs.start({ url: source.mediaUrl, policy: source.policy, quality, variantId, filename: filename || source.id });
    res.status(202).json({ id: job.id, token: job.token, attribution: source.attribution, status: `/download/status/${job.id}`, file: `/download/file/${job.id}?token=${job.token}` });
  }));

  const findJob = (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) { res.status(404).json({ error: "not found" }); return null; }
    return job;
  };

  app.get("/download/status/:id", requireKey, (req, res) => {
    const job = findJob(req, res);
    if (job) res.json(jobs.status(job));
  });

  // The browser can fetch this with the job's one-time token; the file is deleted once fully sent.
  app.get("/download/file/:id", (req, res) => {
    const job = jobs.get(req.params.id);
    const tokenOk = job && typeof req.query.token === "string" && sameSecret(req.query.token, job.token);
    if (!job || !(tokenOk || hasKey(req))) return res.status(404).json({ error: "not found" });
    if (job.state !== "ready" || !job.file) return res.status(409).json({ error: `not ready (${job.state})` });
    res.download(job.file, job.filename, { acceptRanges: false, dotfiles: "allow" }, (err) => {
      if (!err) jobs.remove(job);
    });
  });

  app.delete("/download/:id", requireKey, async (req, res) => {
    const job = findJob(req, res);
    if (job) { await jobs.remove(job); res.status(204).end(); }
  });

  // Malformed JSON or an oversized body.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => res.status(err.status === 413 ? 413 : 400).json({ error: "invalid request" }));

  return app;
}
