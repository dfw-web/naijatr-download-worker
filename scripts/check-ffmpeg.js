// Fails the build when the ffmpeg binary jobs use isn't there or doesn't run.
import { execFileSync } from "node:child_process";
import ffmpegStatic from "ffmpeg-static";

const bin = process.env.FFMPEG_PATH || ffmpegStatic;
try {
  const version = execFileSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" }).split("\n")[0];
  console.log(`ffmpeg ok at ${bin}: ${version}`);
} catch (e) {
  console.error(`ffmpeg unusable at ${bin}: ${e.message}`);
  process.exit(1);
}
