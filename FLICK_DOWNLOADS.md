# Flick download replacement

This branch adds a server-side adaptation of Flickv4's public network resolvers
at revision `87cb0362842f786bb976dc5c2de1d53b2140e5a5`. It keeps the existing Render
service, authenticated download endpoints, job queue, HLS remuxing and cleanup.
It does not change the website or any Play route.

## What is implemented

- `lib/flick.js`: Vidrock movie/TV requests and authenticated URL-metadata parsing
  from Flick's `StreamflixService.ts`; English-source preference; Atlas's
  highest-resolution MP4 list; and a configurable FlixQuest API adapter matching
  Flick's `FlixQuestService.ts` contract.
- `DOWNLOAD_MODE=flick`: every accepted download source must use the Flick
  adapter. Streambert players, direct URL sources and the fixed demo entries
  are rejected. There is no silent browser or Blender fallback.
- Both explicit sourceId and a configured default for title-only requests work.
- Browser callers still cannot supply URLs, headers, API endpoints or host lists.
- Provider API requests, returned media URLs, redirects, playlists, audio, keys
  and segments still use exact host checks, public-IP DNS validation and limits.
- Required media Referer/Origin/User-Agent headers reach the downloader. Cookies
  and Authorization remain scoped to the selected media origin, are removed
  on cross-origin redirects, and are never exposed in API results or logs.
- Provider API credentials, when needed, use `FLICK_API_KEY` on Render only;
  they are sent only to that configured API origin, never to media hosts.
- DASH is explicitly unsupported; it is not mislabeled as HLS.

## What is not implemented or established

Flick is a client, not a repository of downloadable movie files. Its external
providers must be available and permitted for the intended use. This branch
does not include its private scraper backend, device WebView scripts, Videasy
external decryption-service integration, or Vidzee key-retrieval integration.
It does not claim that all providers offered by the native Flick app work here.

The public Vidrock integration has not been tested live from Render. The
FlixQuest backend URL is not published in Flick's runtime config: it must be
supplied by an operator with access. Do not invent an endpoint or authorization
record, or assume that copying Flick's source makes those services available.

HLS quality selection uses the existing worker's master-playlist variants.
For direct MP4 lists, this initial port follows Flick's Atlas behavior and picks
the highest resolution. It does not yet expose an MP4 rendition picker.
Subtitles are not bundled by this port. The existing HLS audio-track behavior is
preserved. Additional provider fallbacks must be explicit and independently
approved; they are not added automatically.

## Cutover on the same Render service

Prepare and validate an approved source first. Keep the replacement on its
branch until live provider checks pass; do not replace working production
configuration with an untested/incomplete host list.

1. Deploy this branch to the existing worker when ready to validate it.
2. Preserve `WORKER_API_KEY`, `FFMPEG_PATH=/usr/bin/ffmpeg`, and job limits.
3. Configure the approved Flick source under `APPROVED_SOURCES_JSON`.
4. Set `DOWNLOAD_MODE=flick` to enforce Flick-only downloads. With no Flick
   source configured, downloads fail closed; health remains available.
5. Set `DEFAULT_DOWNLOAD_SOURCE_ID` to that approved source's ID if the backend
   sends title-only requests. The website's `DOWNLOAD_SOURCE_ID` should name
   the same source if its existing integration sends sourceId.
6. Set `PUPPETEER_SKIP_DOWNLOAD=true` for the Flick-only build. The worker's
   own Chrome installer also skips its download when `DOWNLOAD_MODE=flick`.
7. Remove obsolete Streambert entries from configuration after cutover. Its
   diagnostic flag is unused by the Flick adapter.

### Vidrock source schema

```json
{
  "flick-vidrock": {
    "flick": { "provider": "vidrock" },
    "hosts": ["vidrock.net"],
    "authorization": "",
    "attribution": ""
  }
}
```

This illustrates the schema, NOT a ready-to-deploy source: fill in the actual
permission record and reviewed media/CDN hosts. Empty authorization is rejected.
The initial host list names only the API; returned media will remain blocked
until its exact host is reviewed and configured. Optional `allowedTitles` can
express the scope of a permission record; existing test-title restrictions are
not implicitly applied to new sources.

### FlixQuest source schema

```json
{
  "flick-api": {
    "flick": {
      "provider": "flixquest",
      "apiUrl": "https://YOUR-APPROVED-SCRAPER-API",
      "providerId": "YOUR-APPROVED-PROVIDER"
    },
    "hosts": ["YOUR-APPROVED-SCRAPER-API"],
    "authorization": "",
    "attribution": ""
  }
}
```

Again, this is a schema, not a configured endpoint. It requires a backend you
actually have access to. Its `/api/v2/stream-movie` or `/stream-tv` response must
contain `links`, with each supported link containing `url` and optional headers.
Do not place a backend API key in either JSON schema or browser code.

## Requests

The authenticated API contract remains:

```json
{"sourceId":"flick-vidrock","tmdbId":10378,"type":"movie"}
```

```json
{"sourceId":"flick-vidrock","tmdbId":1399,"type":"tv","season":1,"episode":2}
```

IDs above demonstrate movie/TV syntax only, not authorization for those titles.
Use `/resolve` first, then `/download/start` with the same reference plus a
returned HLS `variantId` or requested HLS `quality`. Status, cancellation and
job-token delivery use existing routes. Do not enable the website Download
button broadly until the chosen source returns the correct actual title and
mobile file delivery has passed. Leave Play untouched.

## Automated verification

`test/flick.test.js` checks metadata parsing, movie/episode routes, scoped
credentials, SSRF rejection, default selection and Flick-only mode. The existing
end-to-end suite now includes a real local fixture API returning generated HLS
with two video qualities and separate audio, plus direct MP4. Media routes
require headers so loss of credentials in playlist/segment fetching fails the
test. The tests fetch/remux/decode the files and verify cleanup. These tests
are not claims that external provider access or the private scraper works.
