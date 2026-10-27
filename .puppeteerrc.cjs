const { join } = require("node:path");

/** Chrome lives in the project, so a host that keeps only the build folder (Render) still has it at runtime. */
module.exports = { cacheDirectory: join(__dirname, ".cache", "puppeteer") };
