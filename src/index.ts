// This plugin does a few things:
//
// 1. Invoke `roc` to build the compiled binary
// 2. Invoke `cc` to convert that binary into a native Node addon (a .node file)
// 3. Copy the binary and its .d.ts type definitions into the appropriate directory

import type { PluginBuild, Plugin } from "esbuild";
import path from "path"

const buildRocFile = require("./build-roc.js")
const rocNodeFileNamespace = "roc-node-file"

function roc(opts?: { cc?: Array<string>; target?: string, optimize?: boolean }) : Plugin {
  const config = opts !== undefined ? opts : {}

  return {
    name: "roc",
    setup(build: PluginBuild) {
      // Resolve ".roc" files to a ".node" path with a namespace
      build.onResolve({ filter: /\.roc$/, namespace: "file" }, (args) => {
        return {
          path: path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, path.dirname(args.path), path.basename(args.path).replace(/\.roc$/, ".node")),
          namespace: rocNodeFileNamespace,
        }
      })

      // Files in the "node-file" virtual namespace call "require()" on the
      // path from esbuild of the ".node" file in the output directory.
      // Strategy adapted from https://github.com/evanw/esbuild/issues/1051#issuecomment-806325487
      build.onLoad({ filter: /.*/, namespace: rocNodeFileNamespace }, (args) => {
        // Load ".roc" files, generate .d.ts files for them, compile and link them into native Node addons,
        // and tell esbuild how to bundle those addons.
        const rocFilePath = args.path.replace(/\.node$/, ".roc")
        const { errors } = buildRocFile(rocFilePath, args.path, config) // TODO get `target` arg from esbuild config

        return {
          contents: `
          import path from ${JSON.stringify(args.path)}
          module.exports = require(path)
        `,
        }
      })

      // If a ".node" file is imported within a module in the "roc-node-file" namespace, put
      // it in the "file" namespace where esbuild's default loading behavior will handle
      // it. It is already an absolute path since we resolved it to one earlier.
      build.onResolve({ filter: /\.node$/, namespace: rocNodeFileNamespace }, (args) => ({
        path: args.path,
        namespace: "file",
      }))

      // Use the `file` loader for .node files by default.
      let opts = build.initialOptions

      opts.loader = opts.loader || {}

      opts.loader[".node"] = "file"
    },
  }
}

export default { roc, buildRocFile }
