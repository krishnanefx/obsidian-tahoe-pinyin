// Bundles src/main.js (and pinyin-pro, its dictionary) into the main.js Obsidian loads.
// usage: node esbuild.config.mjs [--watch]
import { build, context } from "esbuild";

const notice = `/*
 * Tahoe Pinyin — https://github.com/krishnanefx/obsidian-tahoe-pinyin (MIT).
 * Includes pinyin-pro (MIT, see THIRD_PARTY_NOTICES.md).
 * Built from src/; edit the sources, not this file.
 */`;

const options = {
  entryPoints: ["src/main.js"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "es2022",
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  minify: true,
  legalComments: "eof",
  logLevel: "warning",
  banner: { js: notice },
};

if (process.argv.includes("--watch")) {
  await (await context(options)).watch();
} else {
  await build(options);
  console.log("built main.js");
}
