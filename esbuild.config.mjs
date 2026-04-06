import esbuild from "esbuild";

const prod = process.argv.includes("production");

esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  outfile: "main.js",
  external: [
    "obsidian", "electron",
    // Node builtins
    "http", "https", "fs", "path", "crypto", "net", "stream", "os", "url",
    // CM6 core — provided by Obsidian at runtime
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
  ],
  format: "cjs",
  platform: "node",
  target: "es2020",
  sourcemap: prod ? false : "inline",
  minify: prod,
}).catch(() => process.exit(1));
