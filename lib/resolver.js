import { SourceError } from "./net.js";

/**
 * Turns a title reference ({ tmdbId, type: "movie" | "tv", season, episode })
 * into an approved source: { url, hosts, authorization, attribution? }, the
 * same shape as an APPROVED_SOURCES_JSON entry, for a source you are
 * authorized to use. It is checked like a configured source, and every
 * request still goes through the hosts / SSRF checks.
 *
 * No resolver is implemented: requests without a `sourceId` fail with 501.
 */
// eslint-disable-next-line no-unused-vars
export async function findSource(ref, { signal } = {}) {
  throw new SourceError("no source resolver configured", 501);
}
