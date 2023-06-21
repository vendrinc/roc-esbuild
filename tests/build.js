// Accepts a CLI arg for the directory of the test to run.
const testDir = process.argv[2]

// Accepts a CLI arg for whether to cross-compile
const crossCompile = process.argv[3].startsWith("--cross-compile") ? process.argv[3].replace(/^--cross-compile=/, "") : undefined

const path = require("path")
const fs = require("fs")
const esbuild = require("esbuild")
const roc = require("roc-esbuild").default
const { execSync } = require("child_process")

const distDir = path.join(testDir, "dist")
const outfile = path.join(distDir, "output.js")

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir)

async function build() {
  const pluginArg = crossCompile ? { cc: ["zig", "cc"], target: crossCompile } : undefined;

  await esbuild
    .build({
      entryPoints: [path.join(testDir, "test.ts")],
      bundle: true,
      outfile,
      sourcemap: "inline",
      platform: "node",
      minifyWhitespace: true,
      treeShaking: true,
      plugins: [roc(pluginArg)],
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    });
}

build()
