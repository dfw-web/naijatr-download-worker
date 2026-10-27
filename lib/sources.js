import { SourceError } from "./net.js";
import { providerPlayer } from "./providers.js";
import { checkFlickConfig } from "./flick.js";

const PLACEHOLDER = /\{(tmdbId|season|episode)\}/g;
const hostOf = (url) => {
  try { return new URL(String(url).replace(PLACEHOLDER, "1")).hostname.toLowerCase(); } catch { return null; }
};

/**
 * An approved source: { url, hosts, authorization, attribution? }, or a player
 * page whose media URL is detected: { player: { movie?, tv? }, hosts, ... }
 * with "{tmdbId}", "{season}", "{episode}" in its URL templates.
 * `hosts` lists every host the source may touch (player page, its scripts,
 * playlist, segments, audio, redirects), exactly, no wildcards, and must
 * include the url's own host.
 * `authorization` records the permission or license for downloading it.
 */
export function checkSource(id, s) {
  const flick = s?.flick ? checkFlickConfig(s.flick) : null;
  if (flick && (s.url != null || s.player != null || s.provider != null)) throw new Error(`approved source "${id}" cannot mix Flick and legacy resolvers`);
  if (s?.provider != null) {
    if (s.url != null || s.player != null) throw new Error(`approved source "${id}" cannot combine provider with url or player`);
    s = { ...s, player: providerPlayer(s.provider) };
  }
  const player = s?.player && typeof s.player === "object" ? { movie: s.player.movie ?? null, tv: s.player.tv ?? null } : null;
  const urls = flick ? [flick.apiUrl] : player ? [player.movie, player.tv].filter((u) => u != null) : [s?.url];
  const hosts = Array.isArray(s?.hosts) ? s.hosts.map((h) => String(h).trim().toLowerCase()) : [];
  const allowedTitles = s.allowedTitles ?? null;
  if (allowedTitles !== null && (!Array.isArray(allowedTitles) || !allowedTitles.length || allowedTitles.some((t) => typeof t !== "string" || !/^(movie:[1-9]\d{0,8}|tv:[1-9]\d{0,8}:\d{1,9}:[1-9]\d{0,8})$/.test(t))))
    throw new Error(`approved source "${id}" has invalid allowedTitles`);
  if (!urls.length || urls.some((u) => typeof u !== "string" || !hosts.includes(hostOf(u))) || hosts.some((h) => !h || h.includes("*") || h.includes(",")) || typeof s.authorization !== "string" || !s.authorization.trim())
    throw new Error(`approved source "${id}" needs a url (or player urls), exact hosts (including the url's host) and authorization`);
  return { id, url: flick || player ? null : s.url, player, flick, hosts, allowedTitles, authorization: s.authorization, attribution: typeof s.attribution === "string" ? s.attribution : null };
}

/** Optional per-source licence scope; callers cannot change it. */
export function assertTitleAllowed(source, ref) {
  if (!source.allowedTitles) return;
  const key = ref.type === "tv" ? `tv:${ref.tmdbId}:${ref.season}:${ref.episode}` : `movie:${ref.tmdbId}`;
  if (!source.allowedTitles.includes(key)) throw new SourceError("title is not approved for this source", 403);
}

/** A player source's page for one title. Only numbers are filled in; callers never send URLs. */
export function playerUrl(source, { tmdbId, type, season, episode }) {
  if (type !== "movie" && type !== "tv") throw new SourceError("type must be movie or tv");
  assertTitleAllowed(source, { tmdbId, type, season, episode });
  const num = (v, name) => {
    if (!/^\d{1,9}$/.test(String(v ?? ""))) throw new SourceError(`${name} must be a number`);
    return String(v);
  };
  const template = type === "tv" ? source.player.tv : source.player.movie;
  if (!template) throw new SourceError(`this source has no ${type === "tv" ? "tv" : "movie"} player`);
  const values = { tmdbId: template.includes("{tmdbId}") ? num(tmdbId, "tmdbId") : "" };
  if (type === "tv") Object.assign(values, { season: num(season, "season"), episode: num(episode, "episode") });
  return template.replace(PLACEHOLDER, (_, k) => values[k]);
}

/** APPROVED_SOURCES_JSON -> Map of sourceId -> approved source. Bad config stops the server. */
export function loadSources(json) {
  const raw = JSON.parse(json || "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("APPROVED_SOURCES_JSON must be a JSON object");
  return new Map(Object.entries(raw).map(([id, s]) => [id, checkSource(id, s)]));
}
