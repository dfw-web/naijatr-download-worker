import { SourceError } from "./net.js";

/**
 * Turns a title reference ({ tmdbId, type: "movie" | "tv", season, episode })
 * into a direct MP4 or .m3u8 URL from a source you are authorized to use.
 * The returned URL still goes through the ALLOWED_SOURCE_HOSTS / SSRF checks.
 *
 * No resolver is implemented: requests without a `url` fail with 501.
 */
// eslint-disable-next-line no-unused-vars
export async function findSource(ref, { signal } = {}) {
  throw new SourceError("no source resolver configured", 501);
}
