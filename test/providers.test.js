import test from "node:test";
import assert from "node:assert/strict";
import { providerIds, providerPlayer } from "../lib/providers.js";
import { loadSources, playerUrl } from "../lib/sources.js";
import { findSource } from "../lib/resolver.js";

// No third-party player or copyrighted media is fetched by these tests.
const expected = {
  vidsrc: ["vsembed.su", "/embed/movie/550", "/embed/tv/1399/1/2"],
  vidfast: ["vidfast.vc", "/movie/550", "/tv/1399/1/2"],
  vidlove: ["player.vidlove.cc", "/embed/movie/550", "/embed/tv/1399/1/2"],
  aether: ["aether.ist", "/media/tmdb-movie-550", "/media/tmdb-tv-1399/1/2"],
  vidrift: ["embed.vidrift.net", "/embed/movie/550", "/embed/tv/1399/1/2"],
  vidnest: ["vidnest.fun", "/movie/550", "/tv/1399/1/2"],
  frembed: ["frembed.uno", "/embed/movie/550", "/embed/serie/1399"],
};

for (const id of providerIds) {
  test(`${id}: approved config constructs the actual Streambert movie and TV routes`, () => {
    const [host, moviePath, tvPath] = expected[id];
    const sources = loadSources(JSON.stringify({ chosen: { provider: id, hosts: [host], authorization: "test configuration only; not media permission" } }));
    const source = sources.get("chosen");
    const movie = new URL(playerUrl(source, { type: "movie", tmdbId: 550 }));
    const tv = new URL(playerUrl(source, { type: "tv", tmdbId: 1399, season: 1, episode: 2 }));
    assert.equal(movie.hostname, host);
    assert.equal(movie.pathname, moviePath);
    assert.equal(tv.pathname, tvPath);
    if (id === "frembed") {
      assert.equal(tv.searchParams.get("sa"), "1");
      assert.equal(tv.searchParams.get("epi"), "2");
    }
  });
}

test("provider presets do not enable or silently substitute sources", () => {
  assert.equal(loadSources(undefined).size, 0);
  for (const id of ["__proto__", "constructor", "unknown", "hianime", "devideosrc", "kinohub"]) {
    assert.throws(() => providerPlayer(id), /unsupported provider/);
  }
  const player = providerPlayer("vidfast");
  player.movie = "https://evil.example";
  assert.match(providerPlayer("vidfast").movie, /^https:\/\/vidfast\.vc\//);
});

test("provider config still requires approval, exact hosts and unambiguous templates", () => {
  const ok = { provider: "vidfast", hosts: ["vidfast.vc"], authorization: "test only" };
  for (const bad of [
    { ...ok, authorization: "" },
    { ...ok, hosts: ["*.vc"] },
    { ...ok, hosts: ["wrong.example"] },
    { ...ok, player: { movie: "https://evil.example/{tmdbId}" } },
    { ...ok, url: "https://vidfast.vc/anything" },
  ]) assert.throws(() => loadSources(JSON.stringify({ chosen: bad })));
});

test("title resolver selects one approved player and validates the title without fetching", async () => {
  const sources = loadSources(JSON.stringify({ chosen: { provider: "vidfast", hosts: ["vidfast.vc"], authorization: "test only" } }));
  const opts = { sources, defaultSourceId: "chosen" };
  const ref = { type: "movie", tmdbId: "550" };
  assert.equal((await findSource(ref, opts)).id, "chosen");
  await assert.rejects(findSource({ ...ref, tmdbId: "550/../" }, opts), /must be a number/);
  await assert.rejects(findSource({ ...ref, type: "invalid" }, opts), /type must be/);
  await assert.rejects(findSource(ref, { sources, defaultSourceId: "missing" }), /not approved/);
  await assert.rejects(findSource(ref, { sources, defaultSourceId: "" }), (e) => e.status === 501);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(findSource(ref, { ...opts, signal: abort.signal }), { name: "AbortError" });
});

test("provider licence scope allows only the explicitly approved movie or episode", async () => {
  const source = loadSources(JSON.stringify({ chosen: { provider: "vidfast", hosts: ["vidfast.vc"], authorization: "test only", allowedTitles: ["movie:10378", "tv:1399:1:2"] } })).get("chosen");
  assert.match(playerUrl(source, { type: "movie", tmdbId: 10378 }), /10378/);
  assert.match(playerUrl(source, { type: "tv", tmdbId: 1399, season: 1, episode: 2 }), /1399\/1\/2/);
  for (const ref of [{ type: "movie", tmdbId: 550 }, { type: "movie" }, { type: "tv", tmdbId: 1399, season: 1, episode: 3 }]) assert.throws(() => playerUrl(source, ref), (e) => e.status === 403);
  await assert.rejects(findSource({ type: "movie", tmdbId: 550 }, { sources: new Map([["chosen", source]]), defaultSourceId: "chosen" }), (e) => e.status === 403);
  for (const allowedTitles of [[], "movie:10378", ["movie:*"], ["movie:550/../"], [null]]) assert.throws(() => loadSources(JSON.stringify({ chosen: { provider: "vidfast", hosts: ["vidfast.vc"], authorization: "test only", allowedTitles } })));
});

test("title resolver refuses direct files and demo players shared by every title", async () => {
  const sources = loadSources(JSON.stringify({
    direct: { url: "https://test.example/movie.mp4", hosts: ["test.example"], authorization: "test only" },
    demo: { player: { movie: "https://test.example/demo" }, hosts: ["test.example"], authorization: "test only" },
  }));
  const ref = { type: "movie", tmdbId: "550" };
  await assert.rejects(findSource(ref, { sources, defaultSourceId: "direct" }), /title-aware player/);
  await assert.rejects(findSource(ref, { sources, defaultSourceId: "demo" }), /requested title/);
});
