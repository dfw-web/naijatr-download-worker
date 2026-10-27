import { SourceError } from "./net.js";
import { loadSources, playerUrl } from "./sources.js";
import { validateFlickRef } from "./flick.js";

/**
 * Turns a title reference ({ tmdbId, type: "movie" | "tv", season, episode })
 * into an approved source: { url, hosts, authorization, attribution? }, the
 * same shape as an APPROVED_SOURCES_JSON entry, for a source you are
 * authorized to use. It is checked like a configured source, and every
 * request still goes through the hosts / SSRF checks.
 *
 * Selects one explicitly approved title-aware player, not a title-to-file map.
 * The browser detector and downloader still run after this function returns.
 * No source is enabled implicitly; missing configuration remains a 501.
 */
export async function findSource(ref, {
  signal,
  sources,
  defaultSourceId = process.env.DEFAULT_DOWNLOAD_SOURCE_ID,
} = {}) {
  signal?.throwIfAborted();
  if (!defaultSourceId) throw new SourceError("no source resolver configured", 501);
  const configured = sources ?? loadSources(process.env.APPROVED_SOURCES_JSON);
  const source = configured.get(defaultSourceId);
  if (!source) throw new SourceError("default download source is not approved", 503);
  if (source.flick) { validateFlickRef(ref); return source; }
  if (!source.player) throw new SourceError("default download source must be a title-aware player", 503);
  const template = ref.type === "tv" ? source.player.tv : source.player.movie;
  if (!template?.includes("{tmdbId}")) throw new SourceError("default download source must resolve the requested title", 503);
  playerUrl(source, ref); // Validate the reference before starting a browser/job.
  return source;
}
