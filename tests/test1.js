const path = require("path")
const fs = require("fs")
const esbuild = require("esbuild")
const roc = require("roc-esbuild").default
const { execSync } = require("child_process")
const dist = require("roc-esbuild")

const testDir = path.join(__dirname, "test1")
const distDir = path.join(testDir, "dist")
const outfile = path.join(distDir, "output.js")

fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir)

console.log("Building into", outfile)

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
      plugins: [roc()],
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })

  console.log("exists? ", outfile, fs.existsSync(outfile))

  execSync("node " + outfile, { stdio: "inherit" })
}

build()
