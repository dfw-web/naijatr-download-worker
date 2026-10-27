// Adapted from Flickv4 src/services/StreamflixService.ts and
// src/services/FlixQuestService.ts, revision 87cb0362842f786bb976dc5c2de1d53b2140e5a5.
// Copyright (C) 2025 Wendale Franz Dy. GPL-3.0-or-later; see NOTICE.
// Changes: Node crypto, guarded requests, explicit host/credential scopes,
// validated title references, no native UI/browser, no raw-URL logging.
import { createDecipheriv } from "node:crypto";
import { checkUrl, fetchText, SourceError } from "./net.js";

const ROOT = "https://vidrock.net";
const UA = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
// Public metadata-format constant in upstream Flick; not a worker/API secret.
// This decrypts a JSON URL field, never encrypted video or DRM.
const METADATA_KEY = Buffer.from("7f3e9c2a8b5d1f4e6a9c3b7d2e5f8a1c4b6d9e2f5a8c1b4d7e9f2a5c8b1d4e7f", "hex");

export function validateFlickRef(ref) {
  if (!["movie", "tv"].includes(ref.type)) throw new SourceError("type must be movie or tv");
  const number = (value, name, zero = false) => {
    if (!["string", "number"].includes(typeof value) || !(zero ? /^\d{1,9}$/ : /^[1-9]\d{0,8}$/).test(String(value))) throw new SourceError(`${name} must be a valid integer`);
    return String(value);
  };
  const result = { type: ref.type, tmdbId: number(ref.tmdbId, "tmdbId") };
  if (ref.type === "tv") Object.assign(result, { season: number(ref.season, "season", true), episode: number(ref.episode, "episode") });
  return result;
}

export function checkFlickConfig(raw) {
  if (!raw || !["vidrock", "flixquest"].includes(raw.provider)) throw new Error("unsupported Flick resolver");
  if (raw.provider === "vidrock") return { provider: "vidrock", apiUrl: ROOT };
  let url;
  try { url = new URL(raw.apiUrl); } catch { throw new Error("Flick FlixQuest needs an approved API URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || typeof raw.providerId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(raw.providerId)) throw new Error("invalid Flick API configuration");
  return { provider: "flixquest", apiUrl: url.href.replace(/\/+$/, ""), providerId: raw.providerId };
}

export function decryptFlickUrl(payload) {
  try {
    const data = Buffer.from(payload, "base64url");
    if (data.length < 29) return null;
    const decrypt = createDecipheriv("aes-256-gcm", METADATA_KEY, data.subarray(0, 12));
    decrypt.setAuthTag(data.subarray(-16));
    const url = Buffer.concat([decrypt.update(data.subarray(12, -16)), decrypt.final()]).toString("utf8").trim();
    return /^https?:\/\//i.test(url) ? url : null;
  } catch { return null; }
}

/** Headers are selected afresh at every validated redirect/resource URL. */
export function scopedMediaHeaders(raw, mediaUrl) {
  const original = new URL(mediaUrl);
  const headers = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    const lower = key.toLowerCase();
    if (!["referer", "origin", "user-agent", "cookie", "authorization"].includes(lower) || typeof value !== "string" || /[\r\n]/.test(value) || value.length > 8192) continue;
    headers[lower] = value;
  }
  return (url) => {
    // Never send any provider-supplied header over an HTTPS downgrade.
    if (original.protocol === "https:" && url.protocol !== "https:") return {};
    return Object.fromEntries(Object.entries(headers).filter(([key]) => !["cookie", "authorization"].includes(key) || url.origin === original.origin));
  };
}

async function jsonAt(url, policy, signal, headersFor, getText) {
  const doc = await getText(url, policy, { signal, headersFor }, 2 * 1024 * 1024);
  try { return JSON.parse(doc.text); } catch { throw new SourceError("Flick provider returned invalid JSON", 502); }
}

function approvedMedia(url, headers, policy) {
  checkUrl(url, policy); // Also applied by every later fetch and redirect.
  return { url, headersFor: scopedMediaHeaders(headers, url) };
}

/** Flick's network adapters only; no Streambert or demo fallback. */
export async function resolveFlick(source, rawRef, { signal, policy, getText = fetchText, apiKey = process.env.FLICK_API_KEY } = {}) {
  signal?.throwIfAborted();
  const ref = validateFlickRef(rawRef);
  const config = source.flick;
  if (config.provider === "flixquest") {
    const root = config.apiUrl.endsWith("/api/v2") ? config.apiUrl : config.apiUrl + "/api/v2";
    const url = new URL(root + (ref.type === "tv" ? "/stream-tv" : "/stream-movie"));
    url.searchParams.set("tmdbId", ref.tmdbId);
    url.searchParams.set("provider", config.providerId);
    url.searchParams.set("full", "true");
    if (ref.type === "tv") { url.searchParams.set("season", ref.season); url.searchParams.set("episode", ref.episode); }
    const headersFor = (target) => apiKey && target.origin === url.origin ? { authorization: `Bearer ${apiKey}` } : {};
    const data = await jsonAt(url.href, policy, signal, headersFor, getText);
    if (data.success === false) throw new SourceError("Flick scraper rejected the request", 502);
    // DASH is not HLS and is not silently sent to our HLS downloader.
    const link = Array.isArray(data.links) && data.links.find((v) => typeof v?.url === "string" && !v.isDASH && !/\.mpd(?:[?#]|$)/i.test(v.url));
    if (!link) throw new SourceError("Flick returned no supported video source", 404);
    return approvedMedia(link.url, link.headers, policy);
  }
  if (config.provider !== "vidrock") throw new SourceError("unsupported Flick resolver");
  const url = ROOT + (ref.type === "tv" ? `/api/tv/${ref.tmdbId}/${ref.season}/${ref.episode}` : `/api/movie/${ref.tmdbId}`);
  const apiHeaders = { referer: ROOT + "/", origin: ROOT, "user-agent": UA };
  const data = await jsonAt(url, policy, signal, (target) => target.origin === ROOT ? apiHeaders : {}, getText);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new SourceError("Flick provider returned invalid source data", 502);
  const english = (v) => String(v?.language).toLowerCase() === "english" || String(v?.flag).toLowerCase() === "us";
  const entries = Object.entries(data).sort(([an, a], [bn, b]) => Number(english(b)) - Number(english(a)) || Number(an.toLowerCase() === "atlas") - Number(bn.toLowerCase() === "atlas"));
  for (const [name, value] of entries) {
    const media = typeof value?.url === "string" ? decryptFlickUrl(value.url) : null;
    if (!media) continue;
    checkUrl(media, policy);
    if (name.toLowerCase() === "atlas") {
      const list = await jsonAt(media, policy, signal, scopedMediaHeaders(apiHeaders, media), getText);
      const best = Array.isArray(list) && list.filter((v) => typeof v?.url === "string").sort((a, b) => (Number(b.resolution) || 0) - (Number(a.resolution) || 0))[0];
      if (!best) continue;
      return approvedMedia(best.url, apiHeaders, policy);
    }
    return approvedMedia(media, apiHeaders, policy);
  }
  throw new SourceError("Flick returned no video source for this title", 404);
}
