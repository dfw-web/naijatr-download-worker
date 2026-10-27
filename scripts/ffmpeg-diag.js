// Temporary: which ffmpeg step crashes on the build machine.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ffdiag-"));
for (const bin of [ffmpegStatic, "/usr/bin/ffmpeg"]) {
  const step = (name, args) => {
    try { execFileSync(bin, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }); console.log(`diag ${bin} ${name}: ok`); }
    catch (e) { console.log(`diag ${bin} ${name}: ${e.signal || e.code || ""} ${String(e.stderr || "").trim().split("\n").pop()}`); }
  };
  if (!fs.existsSync(bin)) { console.log(`diag ${bin}: missing`); continue; }
  step("mpeg4 encode", ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-c:v", "mpeg4", "a.mp4"]);
  step("x264 encode", ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=25:duration=2", "-c:v", "libx264", "b.mp4"]);
  step("hls write (copy)", ["-i", "a.mp4", "-c", "copy", "-f", "hls", "-hls_time", "1", "-hls_playlist_type", "vod", "-hls_segment_filename", "v_%02d.ts", "v.m3u8"]);
  step("hls remux", ["-allowed_extensions", "ALL", "-protocol_whitelist", "file,crypto", "-i", "v.m3u8", "-c", "copy", "out.mp4"]);
  step("hls remux no opts", ["-i", "v.m3u8", "-c", "copy", "out2.mp4"]);
  step("mp4 remux", ["-i", "a.mp4", "-c", "copy", "-movflags", "+faststart", "out3.mp4"]);
}
fs.rmSync(dir, { recursive: true, force: true });
