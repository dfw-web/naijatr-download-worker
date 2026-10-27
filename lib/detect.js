// Finds the media URL an approved player page loads.
//
// Adapted from Streambert, https://github.com/truelockmc/streambert
// (index.js, setupSession(): the player session's webRequest.onBeforeRequest
// handler that lets "*.m3u8" requests through and reports their URLs).
// Copyright (C) truelockmc. Streambert is free software licensed under the
// GNU General Public License v3.0; this file is distributed under the same
// licence, see LICENSE and NOTICE.
//
// Changes from Streambert: runs in headless Chromium on the server instead of
// an Electron <webview>; the page can only reach the approved source's hosts
// (DNS is pinned to their checked public addresses, every request is checked
// like the downloader's); ".m3u8" is looked for in the URL's path, not its
// query, and page navigations never count, so a player page whose query names
// a playlist isn't taken for the playlist; direct video files (resource type
// "media") count as found media too; no ad blocking, header stripping or
// user-agent changes.
import dns from "node:dns/promises";
import net from "node:net";
import { checkUrl, SourceError } from "./net.js";

/** Streambert's test for a player's HLS request, plus plain video files. */
export const isMediaRequest = (url, resourceType) => resourceType !== "document" && (new URL(url).pathname.includes(".m3u8") || resourceType === "media");

/**
 * Chromium --host-resolver-rules: each approved host resolves only to its
 * checked public address, every other name and IP fails (Chromium applies
 * MAP * to IP literals too, so an approved IP is excluded from it). Pinning
 * the address also stops DNS rebinding between this check and the browser's
 * own lookup.
 */
export async function pinnedHosts(hosts, policy, lookup = dns.lookup) {
  const rules = [];
  const ips = [];
  for (const host of hosts) {
    if (net.isIP(host)) {
      if (!policy.allowIp(host)) throw new SourceError(`address not allowed: ${host}`, 403);
      ips.push(`EXCLUDE ${host}`);
      continue;
    }
    const addrs = await lookup(host, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => !policy.allowIp(a.address))) throw new SourceError(`address not allowed: ${host}`, 403);
    rules.push(`MAP ${host} ${addrs[0].family === 6 ? `[${addrs[0].address}]` : addrs[0].address}`);
  }
  return [...rules, "MAP * ~NOTFOUND", ...ips].join(", ");
}

// One browser at a time: Chromium is the largest thing this service runs.
let queue = Promise.resolve();

/**
 * Opens an approved player page in headless Chromium and resolves with the
 * first media URL it requests. Requests to anything the source's policy
 * doesn't allow are aborted before they leave the browser; onBlocked(host)
 * hears about each (host only, never the URL), to show which hosts a player needs.
 */
export function detectMedia(pageUrl, { hosts, policy, signal, timeoutMs = Number(process.env.DETECT_TIMEOUT_MS) || 45000, lookup, onBlocked } = {}) {
  const run = queue.then(() => detect(pageUrl, { hosts, policy, signal, timeoutMs, lookup, onBlocked }));
  queue = run.catch(() => {});
  return run;
}

async function detect(pageUrl, { hosts, policy, signal, timeoutMs, lookup, onBlocked }) {
  checkUrl(pageUrl, policy);
  signal?.throwIfAborted();
  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      `--host-resolver-rules=${await pinnedHosts(hosts, policy, lookup)}`,
      // Keep cross-site iframes in this page so their requests are checked too.
      "--disable-site-isolation-trials",
      "--disable-features=IsolateOrigins,site-per-process",
      // No WebRTC UDP: it would skip the request checks.
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ...(process.env.CHROME_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    ],
  });
  try {
    // Pop-ups are not this page; close them before they load.
    browser.on("targetcreated", async (target) => {
      if (target.type() === "page" && target.opener()) (await target.page())?.close().catch(() => {});
    });
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new SourceError("no media found on the player page", 404)), timeoutMs);
      const stop = () => reject(signal.reason instanceof Error ? signal.reason : new SourceError("cancelled"));
      signal?.addEventListener("abort", stop, { once: true });
      const done = (fn, value) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        fn(value);
      };
      page.on("request", (req) => {
        const url = req.url();
        if (url.startsWith("data:") || url.startsWith("blob:")) return req.continue();
        try {
          checkUrl(url, policy);
        } catch {
          try { onBlocked?.(new URL(url).host); } catch { /* not a URL */ }
          return req.abort("blockedbyclient");
        }
        if (!isMediaRequest(url, req.resourceType())) return req.continue();
        // The downloader fetches it again with its own checks.
        req.abort("aborted");
        done(resolve, url);
      });
      page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }).then(
        // Many players start only when tapped, as a viewer would.
        () => setTimeout(() => page.mouse.click(page.viewport().width / 2, page.viewport().height / 2).catch(() => {}), 3000),
        (e) => { if (!/net::ERR_ABORTED/.test(e.message)) done(reject, new SourceError("player page did not load", 502)); },
      );
    });
  } finally {
    await browser.close().catch(() => {});
  }
}
