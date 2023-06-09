// This script does a few things:
//
// 1. Invoke `roc` to build the compiled binary
// 2. Invoke `zig` to convert that binary into a native Node addon (a .node file)
// 3. Copy the binary and its .d.ts type definitions into the appropriate directory

import { execSync, spawnSync } from "child_process";
import fs from "fs"
import os from "os"
import path from "path"

const ccTargetFromRocTarget = (rocTarget: string) => {
  switch (rocTarget) {
    case "":
      return "";
    case "linux64":
      return "--target=x86_64-linux-gnu";
    case "linux32":
      return "--target=i386-linux-gnu";
    case "windows64":
      return "--target=x86_64-windows-gnu";
    case "wasm32":
      return "--target=wasm32-unknown-unknown";
    default:
      throw `Unrecognized --target option for roc compiler: ${rocTarget}`;
  }
};

const buildRocFile = async (rocFilePath: string, addonPath: string, config: { cc: Array<string>; target: string }) => {
  const { cc, target } = config
  const rocFileName = path.basename(rocFilePath);
  const rocFileDir = path.dirname(rocFilePath);
  const errors = [];

  // Build the initial Roc object binary for the current OS/architecture.
  //
  // This file may be rebuilt and overridden by a later build step (e.g. when running `yarn package`), but without having
  // some object binary here at this step, `node-gyp` (which `npm install`/`yarn install` run automatically, and there's
  // no way to disable it) will fail when trying to build the addon, because it will be looking for an object
  // binary that isn't there.
  const rocExit = spawnSync(
    "npx",
    [
      "--yes",
      "roc-lang@0.0.0-2023-05-31-nightly-modified-linux",
      "build",
      target === "" ? "" : `--target=${target}`,
      "--no-link",
      path.join(rocFileDir, "main.roc"),
    ].filter(part => part !== ""),
    {
      stdio: "inherit",
    }
  );

  if (rocExit.error) {
    throw new Error(
      "During the npm preinstall hook, `roc build` errored with " +
        rocExit.error
    );
  }

  // Use the appropriate .d.ts file based on our system's architecture.
  const dtsPath = path.join(
    rocFileDir,
    "platform",
    "glue",
    os.arch() + ".roc.d.ts"
  );

  fs.copyFileSync(dtsPath, path.join(rocFileDir, "addon.d.ts"));

  // Link the compiled roc binary into a native node addon. This replaces what binding.gyp would do in most
  // native node addons, except it can works cross-platform (if { cc: ["zig", "cc"] } is used for the config)
  // and runs much faster because it's a single command.

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

  // For now, these are hardcoded. In the future we can extract them into a function to call for multiple entrypoints.
  const ccTarget = ccTargetFromRocTarget(target);
  const rocLibName = "main.roc";
  const nodeAddonName = "addon";
  const cGluePath = path.join(rocFileDir, "platform", "glue", "node-to-roc.c");
  const rocLibDir = rocFileDir;

  const rocLib = path.join(rocLibDir, `lib${rocLibName}.o`);
  const includeRoot = path.resolve(process.execPath, "..", "..");
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
  ]
    .map((suffix) => "-I" + path.join(includeRoot, suffix))
    .join(" ");

  const defines = [
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
  ]
    .map((flag) => "-D'" + flag + "'")
    .join(" ");

  const libraries = ["c", "m", "pthread", "dl", "rt", "util"]
    .map((library) => "-l" + library)
    .join(" ");

  const zigCmd = [
    "zig",
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
    "-O3",
    "-fno-omit-frame-pointer",
    "-MMD",
    libraries,
    "-shared",
  ].flat().filter(part => part !== "").join(" ")

  // Compile the node <-> roc C bridge and statically link in the .o binary (produced by `roc`) into addon.node
  execSync(zigCmd, { stdio: "inherit" });

  return { errors: [] };
};

module.exports = buildRocFile;
