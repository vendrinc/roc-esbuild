const fs = require("fs/promises")
const path = require("path")
const esbuild = require("esbuild")
const rocPlugin = require("..")

async function build(externalDeps) {
  esbuild
    .build({
      entryPoints: ["src/hello.ts"],
      bundle: true,
      outfile: "dist/build.js",
      sourcemap: "inline",
      platform: "node",
      minifyWhitespace: true,
      treeShaking: true,
      external: externalDeps,
      plugins: [rocPlugin],
    })
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}

build(process.argv.slice(2)) // external dependencies come from the command line
