// Installs the chrome-headless-shell build puppeteer expects, where it will look
// at runtime (.puppeteerrc.cjs), and fails the build if it isn't there after.
// (The `puppeteer browsers install` command exited 0 without installing on Render.)
import fs from "node:fs";
import { Browser, detectBrowserPlatform, install } from "@puppeteer/browsers";
import puppeteer from "puppeteer";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const cacheDir = puppeteer.configuration.cacheDirectory;
const buildId = PUPPETEER_REVISIONS["chrome-headless-shell"];
await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform: detectBrowserPlatform() });
const exe = puppeteer.executablePath({ headless: "shell" });
if (!fs.existsSync(exe)) {
  console.error(`chrome-headless-shell ${buildId} missing at ${exe}`);
  process.exit(1);
}
console.log(`chrome-headless-shell ${buildId} installed at ${exe}`);
