import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import fs from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

// Addresses a source URL may never reach: loopback, private, link-local
// (cloud metadata 169.254.169.254 / fd00:ec2::254), CGNAT, multicast, reserved.
const blocked = new net.BlockList();
for (const [addr, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4],
]) blocked.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001:db8::", 32], ["100::", 64],
]) blocked.addSubnet(addr, bits, "ipv6");

export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return blocked.check(ip, "ipv4");
  if (!net.isIPv6(ip)) return true;
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address.
  const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return blocked.check(embedded[1], "ipv4");
  if (/^(?:::ffff:|64:ff9b::)[0-9a-f]+:[0-9a-f]+$/.test(lower)) {
    const [hi, lo] = lower.split(":").slice(-2).map((h) => parseInt(h, 16));
    return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
  }
  return blocked.check(ip, "ipv6");
}

/** "a.com, *.b.org" -> matcher. "*.b.org" matches b.org and any subdomain. */
export function hostMatcher(list) {
  const rules = String(list || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return (host) => {
    host = host.toLowerCase().replace(/\.$/, "");
    return rules.some((r) => (r.startsWith("*.") ? host === r.slice(2) || host.endsWith(r.slice(1)) : host === r));
  };
}

/** The production policy: allow-listed hosts, public IPs, standard ports only. */
export function makePolicy(allowedHosts) {
  return { allowHost: hostMatcher(allowedHosts), allowIp: (ip) => !isBlockedIp(ip), allowPort: (p) => p === "" || p === "80" || p === "443" };
}

export class SourceError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export function checkUrl(raw, policy) {
  let url;
  try { url = new URL(raw); } catch { throw new SourceError("invalid URL"); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceError("only http(s) URLs are allowed");
  if (url.username || url.password) throw new SourceError("credentials in URL are not allowed");
  if (!policy.allowPort(url.port)) throw new SourceError("port not allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(host)) {
    if (!policy.allowIp(host)) throw new SourceError("address not allowed");
  }
  if (!policy.allowHost(host)) throw new SourceError(`host not allowed: ${host}`, 403);
  return url;
}

/** DNS lookup that refuses to connect when any resolved address is disallowed (also stops DNS rebinding). */
function guardedLookup(policy) {
  return (hostname, options, cb) => {
    dns.lookup(hostname, { all: true, family: options.family || 0 }, (err, addrs) => {
      if (err) return cb(err);
      const bad = addrs.find((a) => !policy.allowIp(a.address));
      if (bad || !addrs.length) return cb(new SourceError("address not allowed"));
      if (options.all) return cb(null, addrs);
      cb(null, addrs[0].address, addrs[0].family);
    });
  };
}

/**
 * GET with every hop checked (scheme, host allow-list, resolved IP).
 * Resolves with the response stream and the final URL.
 */
export async function safeGet(raw, policy, { signal, timeout = 20000, maxRedirects = 5, headersFor } = {}) {
  let url = checkUrl(raw, policy);
  for (let hop = 0; ; hop++) {
    const res = await new Promise((resolve, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      const req = lib.get(url, { lookup: guardedLookup(policy), signal, timeout, headers: { "user-agent": "naijatr-download-worker", accept: "*/*", ...headersFor?.(url) } }, resolve);
      req.on("timeout", () => req.destroy(new SourceError("source timed out", 504)));
      req.on("error", reject);
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new SourceError("too many redirects", 502);
      url = checkUrl(new URL(res.headers.location, url).href, policy);
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new SourceError(`source answered ${res.statusCode}`, 502);
    }
    return { res, url: url.href };
  }
}

export async function fetchText(raw, policy, opts = {}, limit = 5 * 1024 * 1024) {
  const { res, url } = await safeGet(raw, policy, opts);
  let size = 0;
  const chunks = [];
  for await (const c of res) {
    size += c.length;
    if (size > limit) { res.destroy(); throw new SourceError("playlist too large", 502); }
    chunks.push(c);
  }
  return { text: Buffer.concat(chunks).toString("utf8"), url, headers: res.headers };
}

/** Streams a source to disk; budget.left is shared across a job so one job can't fill the disk. */
export async function fetchToFile(raw, file, policy, budget, opts = {}) {
  const { res } = await safeGet(raw, policy, opts);
  let bytes = 0;
  const counter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      budget.left -= chunk.length;
      if (budget.left < 0) return cb(new SourceError("download exceeds size limit", 413));
      cb(null, chunk);
    },
  });
  await pipeline(res, counter, fs.createWriteStream(file), { signal: opts.signal });
  return bytes;
}
