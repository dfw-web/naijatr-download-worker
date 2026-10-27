/**
 * An approved source: { url, hosts, authorization, attribution? }.
 * `hosts` lists every host the source may touch (playlist, segments, audio,
 * redirects), exactly, no wildcards, and must include the url's own host.
 * `authorization` records the permission or license for downloading it.
 */
export function checkSource(id, s) {
  let host = null;
  try { host = new URL(s?.url).hostname.toLowerCase(); } catch { /* invalid url */ }
  const hosts = Array.isArray(s?.hosts) ? s.hosts.map((h) => String(h).trim().toLowerCase()) : [];
  if (!host || !hosts.includes(host) || hosts.some((h) => !h || h.includes("*") || h.includes(",")) || typeof s.authorization !== "string" || !s.authorization.trim())
    throw new Error(`approved source "${id}" needs a url, exact hosts (including the url's host) and authorization`);
  return { id, url: s.url, hosts, authorization: s.authorization, attribution: typeof s.attribution === "string" ? s.attribution : null };
}

/** APPROVED_SOURCES_JSON -> Map of sourceId -> approved source. Bad config stops the server. */
export function loadSources(json) {
  const raw = JSON.parse(json || "{}");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("APPROVED_SOURCES_JSON must be a JSON object");
  return new Map(Object.entries(raw).map(([id, s]) => [id, checkSource(id, s)]));
}
