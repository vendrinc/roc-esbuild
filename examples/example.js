const path = require("path")
const esbuild = require("esbuild")
const roc = require("roc-esbuild").default

esbuild
  .build({
    entryPoints: [path.join(__dirname, "src", "test.ts")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "build.js"),
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
