const path = require("path")
const esbuild = require("esbuild")
const roc = require("roc-esbuild").default

esbuild
  .build({
    entryPoints: [path.join(__dirname, "test1", "hello.ts")],
    bundle: true,
    outfile: path.join(__dirname, "dist", "output.js"),
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
