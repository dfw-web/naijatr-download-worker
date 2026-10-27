import test from "node:test";
import assert from "node:assert/strict";
import { parseMaster, pickVariant, localizeMedia } from "../lib/hls.js";

const master = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aud"
v360/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720,AUDIO="aud"
https://cdn.example/v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=854x480
v480.m3u8`;

test("parses variants best-first and audio renditions", () => {
  const { variants, audio } = parseMaster(master, "https://h.example/movie/master.m3u8");
  assert.deepEqual(variants.map((v) => v.height), [720, 480, 360]);
  assert.equal(variants[2].uri, "https://h.example/movie/v360/index.m3u8");
  assert.equal(audio[0].uri, "https://h.example/movie/audio/en.m3u8");
  assert.equal(pickVariant(variants).height, 720);
  assert.equal(pickVariant(variants, "worst").height, 360);
  assert.equal(pickVariant(variants, 480).height, 480);
  assert.equal(pickVariant(variants, "600").height, 480);
  assert.equal(pickVariant(variants, 144).height, 360);
  assert.equal(pickVariant(variants, "best", "1").height, 480);
  assert.throws(() => pickVariant(variants, "best", "9"));
});

test("localizes segments, keys and init", () => {
  const media = `#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x01
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4,
s1.m4s
#EXTINF:4,
https://other.example/s2.m4s
#EXT-X-ENDLIST`;
  const { playlist, downloads } = localizeMedia(media, "https://h.example/p/x.m3u8", "v");
  assert.deepEqual(downloads.map((d) => d.url), ["https://h.example/p/key.bin", "https://h.example/p/init.mp4", "https://h.example/p/s1.m4s", "https://other.example/s2.m4s"]);
  assert.match(playlist, /URI="v00000.key",IV=0x01/);
  assert.doesNotMatch(playlist, /https?:/);
  assert.deepEqual(downloads.map((d) => d.name), ["v00000.key", "v00001.mp4", "v00002.m4s", "v00003.m4s"]);
});

test("segment names keep a media extension ffmpeg accepts", () => {
  const names = (media) => localizeMedia(media, "https://h.example/p/x.m3u8", "v").downloads.map((d) => d.name);
  assert.deepEqual(names("#EXTM3U\n#EXTINF:4,\nseg-1.ts?sig=1\n#EXTINF:4,\nseg-2\n#EXTINF:4,\nseg-3.jpg\n#EXT-X-ENDLIST"), ["v00000.ts", "v00001.ts", "v00002.ts"]);
  assert.deepEqual(names('#EXTM3U\n#EXT-X-MAP:URI="init"\n#EXTINF:4,\nchunk-1\n#EXT-X-ENDLIST'), ["v00000.m4s", "v00001.m4s"]);
  assert.throws(() => localizeMedia("#EXTM3U\n#EXT-X-ENDLIST", "https://h/x", "v"), /no segments/);
});

test("refuses live, SAMPLE-AES and byte-range playlists", () => {
  assert.throws(() => localizeMedia("#EXTM3U\n#EXTINF:4,\na.ts", "https://h/x", "v"), /live/);
  assert.throws(() => localizeMedia('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST', "https://h/x", "v"), /SAMPLE-AES/);
  assert.throws(() => localizeMedia("#EXTM3U\n#EXT-X-BYTERANGE:100@0\n#EXTINF:4,\na.ts\n#EXT-X-ENDLIST", "https://h/x", "v"), /byte-range/);
});
