// Fails the build when the ffmpeg jobs use doesn't run, or crashes on the
// worker's own HLS remux (tried on a generated 2-second test stream).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { HLS_IN } from "../lib/jobs.js";

const bin = process.env.FFMPEG_PATH || ffmpegStatic;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-check-"));
const run = (args) => execFileSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
try {
  console.log(`ffmpeg at ${bin}: ${execFileSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" }).split("\n")[0]}`);
  run(["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-f", "lavfi", "-i", "sine=duration=2", "-c:v", "libx264", "-c:a", "aac", "-shortest", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "v_%02d.ts", "v.m3u8"]);
  run([...HLS_IN, "-i", "v.m3u8", "-map", "0:v?", "-map", "0:a?", "-c", "copy", "-movflags", "+faststart", "out.mp4"]);
  console.log(`ffmpeg HLS remux ok (${fs.statSync(path.join(dir, "out.mp4")).size} bytes)`);
} catch (e) {
  console.error(`ffmpeg check failed: ${e.signal ? `killed by ${e.signal}` : String(e.stderr || e.message).trim().split("\n").pop()}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
