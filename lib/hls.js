import { SourceError } from "./net.js";

export function parseAttrs(s) {
  const out = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
}

export const isPlaylist = (text) => text.trimStart().startsWith("#EXTM3U");
export const isMaster = (text) => text.includes("#EXT-X-STREAM-INF");

export function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const audio = [];
  lines.forEach((line, i) => {
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const a = parseAttrs(line.slice(18));
      const uri = lines.slice(i + 1).find((l) => l && !l.startsWith("#"));
      if (!uri) return;
      const [width, height] = (a.RESOLUTION || "x").split("x").map((n) => parseInt(n, 10) || 0);
      variants.push({ uri: new URL(uri, base).href, bandwidth: parseInt(a.BANDWIDTH, 10) || 0, width, height, codecs: a.CODECS || "", audioGroup: a.AUDIO || null });
    } else if (line.startsWith("#EXT-X-MEDIA:")) {
      const a = parseAttrs(line.slice(13));
      if (a.TYPE !== "AUDIO") return;
      audio.push({ groupId: a["GROUP-ID"], name: a.NAME || "", language: a.LANGUAGE || "", default: a.DEFAULT === "YES", uri: a.URI ? new URL(a.URI, base).href : null });
    }
  });
  variants.sort((x, y) => y.height - x.height || y.bandwidth - x.bandwidth);
  variants.forEach((v, i) => { v.id = String(i); });
  return { variants, audio };
}

/** variantId from /resolve, else "best" | "worst" | a height like 720 (at or below it, else the smallest). */
export function pickVariant(variants, quality = "best", variantId) {
  if (!variants.length) throw new SourceError("playlist has no variants", 502);
  if (variantId != null) {
    const v = variants.find((x) => x.id === String(variantId));
    if (!v) throw new SourceError("unknown variantId");
    return v;
  }
  if (quality === "best" || quality == null) return variants[0];
  if (quality === "worst") return variants[variants.length - 1];
  const h = parseInt(quality, 10);
  if (!h) throw new SourceError("quality must be best, worst or a height such as 720");
  return variants.find((v) => v.height <= h) || variants[variants.length - 1];
}

/**
 * Rewrites a VOD media playlist to local file names and lists what to fetch.
 * AES-128 keys are fetched too; live, SAMPLE-AES and byte-range playlists are refused.
 */
export function localizeMedia(text, base, prefix) {
  if (!text.includes("#EXT-X-ENDLIST")) throw new SourceError("live streams are not supported", 422);
  if (text.includes("#EXT-X-BYTERANGE")) throw new SourceError("byte-range playlists are not supported", 422);
  const downloads = [];
  const seen = new Map();
  const local = (uri, ext) => {
    const href = new URL(uri, base).href;
    if (!seen.has(href)) {
      const name = `${prefix}${String(downloads.length).padStart(5, "0")}${ext}`;
      seen.set(href, name);
      downloads.push({ url: href, name });
    }
    return seen.get(href);
  };
  const out = text.split(/\r?\n/).map((raw) => {
    const line = raw.trim();
    if (!line) return line;
    if (line.startsWith("#EXT-X-KEY:") || line.startsWith("#EXT-X-SESSION-KEY:")) {
      const a = parseAttrs(line.slice(line.indexOf(":") + 1));
      if (a.METHOD === "NONE") return line;
      if (a.METHOD !== "AES-128") throw new SourceError(`encryption ${a.METHOD} is not supported`, 422);
      return line.replace(/URI="[^"]*"/, `URI="${local(a.URI, ".key")}"`);
    }
    if (line.startsWith("#EXT-X-MAP:")) {
      const a = parseAttrs(line.slice(11));
      if (a.BYTERANGE) throw new SourceError("byte-range playlists are not supported", 422);
      return line.replace(/URI="[^"]*"/, `URI="${local(a.URI, ".init")}"`);
    }
    if (line.startsWith("#")) return line;
    return local(line, ".seg");
  });
  if (!downloads.some((d) => d.name.endsWith(".seg"))) throw new SourceError("playlist has no segments", 502);
  return { playlist: out.join("\n"), downloads };
}
