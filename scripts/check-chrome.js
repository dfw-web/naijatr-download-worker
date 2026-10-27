// Fails the build when Chrome isn't where the worker will look for it at runtime.
import fs from "node:fs";
import puppeteer from "puppeteer";

const exe = puppeteer.executablePath({ headless: "shell" });
if (!fs.existsSync(exe)) {
  console.error(`chrome-headless-shell missing at ${exe}`);
  process.exit(1);
}
console.log(`chrome-headless-shell installed at ${exe}`);
