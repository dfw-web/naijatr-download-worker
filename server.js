import ffmpegStatic from "ffmpeg-static";
import { loadSources } from "./lib/sources.js";
import { createJobs } from "./lib/jobs.js";
import { createApp } from "./lib/app.js";

const env = process.env;
// See approved-sources.example.json.
const sources = loadSources(env.APPROVED_SOURCES_JSON);
const jobs = createJobs({
  ffmpegPath: env.FFMPEG_PATH || ffmpegStatic,
  maxJobs: Number(env.MAX_JOBS) || 2,
  maxBytes: (Number(env.MAX_DOWNLOAD_MB) || 3072) * 1024 * 1024,
});
const port = env.PORT || 3000;

createApp({ apiKey: env.WORKER_API_KEY, sources, jobs }).listen(port, "0.0.0.0", () => {
  console.log(`naijatr-download-worker listening on port ${port} with ${sources.size} approved source(s)`);
});
