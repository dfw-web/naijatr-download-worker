import test from "node:test";
import assert from "node:assert/strict";
import { isBlockedIp, hostMatcher, makePolicy, checkUrl, safeGet } from "../lib/net.js";

test("blocks private, loopback, metadata and mapped addresses", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "224.0.0.1"])
    assert.equal(isBlockedIp(ip), true, ip);
  for (const ip of ["8.8.8.8", "151.101.1.1", "2606:4700::1111"]) assert.equal(isBlockedIp(ip), false, ip);
});

test("host allow-list with wildcards", () => {
  const m = hostMatcher("a.com, *.b.org");
  assert.ok(m("a.com") && m("b.org") && m("x.y.b.org") && m("A.COM."));
  assert.ok(!m("evil-a.com") && !m("a.com.evil.net") && !m("evilb.org"));
});

test("checkUrl rejects bad schemes, ports, credentials, IPs and hosts", () => {
  const p = makePolicy("ok.com, 8.8.8.8");
  for (const u of ["file:///etc/passwd", "gopher://ok.com/", "ftp://ok.com/x", "http://user:pw@ok.com/", "http://ok.com:8080/", "http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://other.com/", "not a url"])
    assert.throws(() => checkUrl(u, p), u);
  assert.ok(checkUrl("https://ok.com/a.m3u8", p));
});

test("hostnames that resolve to private addresses are refused", async () => {
  await assert.rejects(safeGet("http://localhost/", makePolicy("localhost")), /address not allowed/);
});
