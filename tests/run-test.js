// Accepts a CLI arg for the directory of the test to run.
const testDir = process.argv[2]

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
  await esbuild
    .build({
      entryPoints: [path.join(testDir, "hello.ts")],
      bundle: true,
      outfile,
      sourcemap: "inline",
      platform: "node",
      minifyWhitespace: true,
      treeShaking: true,
      plugins: [roc({ rocPlatformMain: path.join(testDir, "platform", "main.roc")})],
    })
    .catch((err) => {
      console.error(err)
      process.exit(1)
    });

    try {
      execSync("node " + outfile, { stdio: "inherit" })
    }
    catch (err) {
      console.error(err)
      process.exit(1)
    }
}

build()
