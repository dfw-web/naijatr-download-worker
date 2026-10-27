# Streambert provider support

The worker can now construct the real movie/TV player routes from Streambert's
`PLAYER_SOURCES`, then use the existing server-side Chromium detector and
download pipeline. These are not title-to-file mappings.

Registry source: `truelockmc/streambert`, commit
`1a4bf7e665a7fd54c6107d62e258346c24ccd66f`, `src/utils/api.js`.

| Provider ID | Player hostname | ID format |
| --- | --- | --- |
| vidsrc | vsembed.su | TMDB |
| vidfast | vidfast.vc | TMDB |
| vidlove | player.vidlove.cc | TMDB |
| aether | aether.ist | TMDB |
| vidrift | embed.vidrift.net | TMDB |
| vidnest | vidnest.fun | TMDB movies/TV only |
| frembed | frembed.uno | TMDB |

Provider presets do not enable access by themselves. Every configured source
still needs its own authorization record and exact host allowlist. No media
hosts are guessed, inherited from other providers, or automatically approved.
GPL permission applies to the software, not the provider's media.

## Configure an approved provider

Add a source to `APPROVED_SOURCES_JSON`. For example, the schema below shows
Vidfast. Replace the authorization/attribution text with the actual record and
extend `hosts` with its reviewed iframe, script, redirect and media hosts.
The single hostname below is only the initial player host, NOT a claim that
this is a complete working host list or that this provider is licensed.

```json
{
  "approved-player": {
    "provider": "vidfast",
    "hosts": ["vidfast.vc"],
    "authorization": "REPLACE WITH ACTUAL SOURCE PERMISSION RECORD",
    "attribution": "REPLACE WITH REQUIRED ATTRIBUTION"
  }
}
```

Do not combine `provider` with `url` or `player` in the same entry.
Existing direct sources and custom `player` templates continue to work.

### Explicit source requests

The existing website backend may use the existing `DOWNLOAD_SOURCE_ID` setting
to select the configured ID. It must also send the actual title reference:

```json
{"sourceId":"approved-player","tmdbId":550,"type":"movie"}
```

For TV:

```json
{"sourceId":"approved-player","tmdbId":1399,"type":"tv","season":1,"episode":2}
```

These IDs demonstrate routing only; they are not assertions of media rights.
Send these bodies to authenticated `POST /resolve`. After resolution, send the
same fields plus a returned quality/variant choice and filename to
`POST /download/start`. Existing status, file-token and cancellation routes
are unchanged. API callers cannot submit `provider`, `url`, `playerUrl` or hosts.

### Title-only requests

Optionally set `DEFAULT_DOWNLOAD_SOURCE_ID=approved-player` on the worker.
Then `POST /resolve` and `/download/start` can accept a title reference without
`sourceId`. `findSource()` selects that approved player and validates the title;
the existing detector obtains the real media URL afterwards.

This worker variable differs from the website's `DOWNLOAD_SOURCE_ID`.
No default is chosen automatically. A default pointing at a direct file or
the fixed Big Buck Bunny demo is rejected so all titles cannot silently
download the same clip. With no default, title-only requests retain the 501.

## Supported scope and remaining work

- DeVideoSrc requires IMDb conversion, KinoHub requires Kinopoisk conversion,
  and HiAnime has a separate resolver. These are deliberately not accepted as
  TMDB presets. Do not substitute TMDB IDs into those providers' routes.
- Browser detection still returns a URL only. Providers requiring cookies,
  special request headers, a persistent browser session or another protected
  access mechanism may fail. This change does not implement or claim those
  capabilities, nor bypass provider restrictions.
- Known player URLs are not proof of working providers. The detector can also
  observe previews/ads/audio. Before enabling a provider, verify that the file
  is the requested content, not just that a media request appeared.
- Every iframe/script/media host must be explicitly reviewed and listed.
  Unlisted hosts stay blocked. Never turn off SSRF checks to fix detection.
- No provider has been live-tested by adding this registry. Automated tests
  cover URL construction, approved-default selection, validation, disclosure
  prevention, and the existing browser/download flow using generated fixtures.
- No website/Play files, Render environment values or service plan are changed.

Deploy the commit on the existing Render service after tests pass, configure
one approved source, and run a movie and TV end-to-end test where licensed.
Verify resolution, actual content, video/audio decoding, cleanup, and physical
mobile delivery before exposing production Download for that provider.

## Limit a provider to particular licensed titles

An optional `allowedTitles` array restricts both explicit sourceId and
source-default requests before browser detection. Use exact references such
as `["movie:10378"]` for Big Buck Bunny, or `"tv:1399:1:2"` for a specifically
licensed episode. Empty lists, wildcards and malformed references are rejected.
Omitting this field preserves existing source behavior; it does not establish
rights to additional titles.

For host diagnostics, temporarily set `LOG_BLOCKED_SOURCE_HOSTS=1`. The worker
logs at most 20 distinct blocked hostnames per request with the source ID,
never full player/media URLs, cookies or credentials. These diagnostics do not
automatically approve hosts. Remove the setting after troubleshooting.
