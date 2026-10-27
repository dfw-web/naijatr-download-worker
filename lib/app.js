import express from "express";
import crypto from "node:crypto";
import { SourceError } from "./net.js";
import { resolveSource, describe } from "./jobs.js";
import { findSource } from "./resolver.js";

// Open-licensed / sample hosts; set ALLOWED_SOURCE_HOSTS to the hosts you are authorized to download from.
export const DEFAULT_HOSTS = "download.blender.org, archive.org, *.archive.org, test-streams.mux.dev, devstreaming-cdn.apple.com";

const sameSecret = (a, b) => crypto.timingSafeEqual(crypto.createHash("sha256").update(a).digest(), crypto.createHash("sha256").update(b).digest());

export function createApp({ apiKey, policy, jobs }) {
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
    next();
  };
  // A direct `url`, or a title reference handed to the resolver.
  const sourceUrl = async (body) => {
    if (body?.url == null && body?.tmdbId != null) return findSource({ tmdbId: String(body.tmdbId), type: body.type === "tv" ? "tv" : "movie", season: body.season, episode: body.episode });
    if (typeof body?.url !== "string" || body.url.length > 4096) throw new SourceError("url or tmdbId is required");
    return body.url;
  };
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (!(e instanceof SourceError)) console.error(e);
    res.status(e instanceof SourceError ? e.status : 502).json({ error: e instanceof SourceError ? e.message : "source unreachable" });
  });

  app.post("/resolve", requireKey, wrap(async (req, res) => {
    res.json(describe(await resolveSource(await sourceUrl(req.body), policy)));
  }));

  app.post("/download/start", requireKey, wrap(async (req, res) => {
    const { quality, variantId, filename } = req.body;
    const job = jobs.start({ url: await sourceUrl(req.body), quality, variantId, filename });
    res.status(202).json({ id: job.id, token: job.token, status: `/download/status/${job.id}`, file: `/download/file/${job.id}?token=${job.token}` });
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

  return app;
}

