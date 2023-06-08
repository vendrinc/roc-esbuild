// This plugin does a few things:
//
// 1. Invoke `roc` to build the compiled binary
// 2. Invoke `cc` to convert that binary into a native Node addon (a .node file)
// 3. Copy the binary and its .d.ts type definitions into the appropriate directory

const child_process = require("child_process")
const fs = require("fs/promises")
const os = require("os")
const path = require("path")
const util = require("util")
const tmp = require("tmp-promise")
const execFile = util.promisify(child_process.execFile)

const includeRoot = path.resolve(process.execPath, "..", "..")
const includes = [
  "include/node",
  // Note: binding-gyp typically includes these other paths as well, and includes them from
  // this directory on macOS: ~/Library/Caches/node-gyp/16.20.0 - but note that this
  // directory may vary from machine to machine. Finding out where it is probably involves
  // spelunking around in the node-gyp source, e.g. https://github.com/nodejs/node-gyp/blob/aaa117c514430aa2c1e568b95df1b6ed1c1fd3b6/lib/configure.js#L268
  // seems to be what they use based on the name, but that does not seem likely to be correct.
  //
  // On the other hand, https://github.com/nodejs/node-gyp/blob/aaa117c514430aa2c1e568b95df1b6ed1c1fd3b6/addon.gypi#L21
  // shows a precedent for linking directly to the includes inside the node directory rather than from within
  // the binding-gyp directory, but node's directory is missing some of these (e.g. it has no `deps/` directory).
  //
  // For now, as long as we don't need any of these in our addon, it seems not only fine but actively better to leave
  // them out of our build, since it speeds up our build and potentially makes our compiled binary output smaller.
  //
  // "src",
  // "deps/openssl/config",
  // "deps/openssl/openssl/include",
  // "deps/uv/include",
  // "deps/zlib",
  // "deps/v8/include"
].map((suffix) => "-I" + path.join(includeRoot, suffix))

const defines = [
  // TODO is it a problem for multiple different Node addons to have the same name?
  // If not, may need to derive a unique name from the file path at runtime.
  "NODE_GYP_MODULE_NAME=addon",
  "USING_UV_SHARED=1",
  "USING_V8_SHARED=1",
  "V8_DEPRECATION_WARNINGS=1",
  "V8_DEPRECATION_WARNINGS",
  "V8_IMMINENT_DEPRECATION_WARNINGS",
  "_GLIBCXX_USE_CXX11_ABI=1",
  "_LARGEFILE_SOURCE",
  "_FILE_OFFSET_BITS=64",
  "__STDC_FORMAT_MACROS",
  "OPENSSL_NO_PINSHARED",
  "OPENSSL_THREADS",
  "BUILDING_NODE_EXTENSION",
].flatMap((flag) => ["-D", flag])

const libraries = ["c", "m", "pthread", "dl", "rt", "util"].map((library) => "-l" + library)

const ccTargetFromRocTarget = (rocTarget) => {
  switch (rocTarget) {
    case "":
      return ""
    case "linux64":
      return "--target=x86_64-linux-gnu"
    default:
      throw `Unrecognized --target option for roc compiler: ${rocTarget}`
  }
}

const loadRocFile = async (rocFilePath, target) => {
  const rocFileName = path.basename(rocFilePath)
  const rocFileDir = path.dirname(rocFilePath)
  const errors = []

  // Build the initial Roc object binary for the current OS/architecture.
  //
  // This file may be rebuilt and overridden by a later build step (e.g. when running `yarn package`), but without having
  // some object binary here at this step, `node-gyp` (which `npm install`/`yarn install` run automatically, and there's
  // no way to disable it) will fail when trying to build the addon, because it will be looking for an object
  // binary that isn't there.
  const rocExit = await execFile("npx", [
    "--yes",
    "roc-lang@0.0.0-2023-05-31-nightly-modified-linux",
    "build",
    target === "" ? "" : `--target=${target}`,
    "--no-link",
    rocFilePath,
  ])

  if (rocExit.error) {
    // TODO capture stdout/stderr to `errors` and/or `warnings`
    throw new Error("`roc build` errored with " + rocExit.error)
  }

  const rocLib = path.join(rocFileDir, `lib${rocFileName}.o`) // e.g. "libmain.roc.o"

  // TODO replace this with `roc --output=...` once that roc CLI flag lands
  fs.rename(rocFilePath.replace(/.roc$/, ".o"), rocLib)

  // TODO use `roc glue` to generate this file for the .roc file given in args.path
  const cGluePath = path.join(rocFileDir, "platform", "glue", "node-to-roc.c")

  // The .d.ts file needs to be in the same directory as the .roc file, so that e.g. VSCode tooling will pick up on it.
  await fs.copyFile(
    // Use the appropriate .d.ts file based on our system's architecture.
    path.join(rocFileDir, "platform", "glue", os.arch() + ".roc.d.ts"),
    rocFilePath + ".d.ts",
  )

  // Use Zig to link the compiled roc binary into a native node addon. This replaces what binding.gyp would do in most
  // native node addons, except it works cross-platform and runs much faster.

  // NOTE: From here on, everything is built for Node 16.16.0 and may need to be revised to work with future Node versions!
  //
  // When upgrading node.js versions, here's how to verify what normal node-gyp would do here:
  //
  //     rm -rf build
  //     npx node-gyp configure
  //     cd build
  //     V=1 make
  //
  // The Makefile that node-gyp generates inside build/ uses a magical V=1 env var to print
  // what tcc and g++ commands it's doing; this is much nicer than strace output because they
  // spawn these processes with mmap and clone3 rather than exceve, so you can't really see
  // what the arguments to cc and g++ are from there.
  //
  // Then basically swap cc for zig cc -target x86_64-linux-gnu, g++ for zig c++ -target x86_64-linux-gnu,
  // and adjust the input/output directories as needed.

  // This script is a way to build Native Node Addons without using node-gyp.
  // It uses Zig for cross-platform builds, which enables:
  // - Faster builds than node-gyp, which spawns a Python process that generates a Makefile which then runs cc and g++.
  // - Building native Node Addons for a given target operating system, without needing to use something like Docker.
  //   We need this so that we can build Roc addons for Node locally on Apple Silicon developer machines and then ship the
  //   resulting artifact (inside a zip bundle) directly to an x64 Linux Lambda with no builds taking place on the Labmda.
  //   We did not want to use Docker for this primarily because of licensing issues, but this also runs faster than building
  //   on x64 emulation (e.g. using either Docker or podman + qemu).

  // For now, this are hardcoded. In the future we can extract them into a function to call for multiple entrypoints.
  const ccTarget = ccTargetFromRocTarget(target)
  const tempfile = await tmp.file()
  const addonPath = tempfile.path

  // Compile the node <-> roc C bridge and statically link in the .o binary (produced by `roc`) into addon.node
  await execFile(
    // TODO if open-sourcing this plugin, can probably be switched
    // to use `cc` instead of `zig cc` and then opt back into zig
    // with `export CC=zig cc` before running, or an esbuild config
    "zig",
    [
      "cc",
      ccTarget,
      "-o",
      addonPath,
      rocLib,
      cGluePath,
      defines,
      includes,
      "-fPIC",
      "-pthread",
      "-Wall",
      "-Wextra",
      "-Wno-unused-parameter",
      "-m64",
      // "-O3", // TODO enable this in optimized builds
      "-fno-omit-frame-pointer",
      "-MMD",
      libraries,
      "-shared",
    ].flat(),
  )

  // TODO add any errors to `errors`

  return {
    contents: await fs.readFile(addonPath),
    // Don't include these contents in the bundle.
    // Instead, copy the contents to a file, and rewrite the import path to point to it.
    // https://esbuild.github.io/content-types/#copy
    loader: "file",
    errors,
  }
}

module.exports = {
  name: "roc",
  setup(build) {
    // Resolve ".roc" files to a path with a namespace
    build.onResolve({ filter: /\.roc$/ }, (args) => {
      // Resolve relative paths to absolute paths here since this
      // resolve callback is given "resolveDir", the directory to
      // resolve imports against.
      return {
        path: path.isAbsolute(args.path) ? args.path : path.join(args.resolveDir, args.path),
        namespace: "roc",
      }
    })

    // Load ".roc" files, generate .d.ts files for them, compile and link them into native Node addons,
    // and tell esbuild how to bundle those addons.
    build.onLoad({ filter: /\.roc$/ }, async (args) => {
      return loadRocFile(args.path, "linux64") // TODO get the `target` arg from the esbuild config
    })
  },
}

