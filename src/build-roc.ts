// This script does a few things:
//
// 1. Invoke `roc` to build the compiled binary
// 2. Invoke `zig` to convert that binary into a native Node addon (a .node file)
// 3. Copy the binary and its .d.ts type definitions into the appropriate directory

const fs = require("fs");
const os = require("os");
const path = require("path");
const child_process = require("child_process");
const util = require("util");

const { execSync, spawnSync } = child_process
const execFile = util.promisify(child_process.execFile)

const ccTargetFromRocTarget = (rocTarget: string) => {
  switch (rocTarget) {
    case "macos-arm64":
      return "aarch64-apple-darwin"
    case "macos-x64":
      return "x86_64-apple-darwin"
    case "linux-arm64":
      return "aarch64-linux-gnu"
    case "linux-x64":
      return "x86_64-linux-gnu"
    case "linux-x32":
      return "i386-linux-gnu"
    case "windows-x64":
      return "x86_64-windows-gnu"
    case "wasm32":
      return "wasm32-unknown-unknown"
    case "":
      let targetStr = ""

      switch (os.arch()) {
        case "arm":
          targetStr = "arm"
          break
        case "arm64":
          targetStr = "aarch64"
          break
        case "x64":
          targetStr = "x86_64"
          break
        case "ia32":
          targetStr = "i386"
          break
        default:
          throw new Error(`roc-esbuild does not currently support building for this CPU architecture: ${os.arch()}`)
      }

      targetStr += "-"

      switch (os.platform()) {
        case "darwin":
          targetStr += "macos"
          break
        case "win32":
          targetStr += "win32"
          break
        case "linux":
          targetStr += "linux"
          break
        default:
          throw new Error(`roc-esbuild does not currently support building for this operating system: ${os.platform()}`)
      }

      return targetStr

    default:
      throw `Unrecognized --target option for roc compiler: ${rocTarget}`
  }
}

const rocNotFoundErr = "roc-esbuild could not find its roc-lang dependency in either its node_modules or any parent node_modules. This means it could not find the `roc` binary it needs to execute!";

function runRoc(args: Array<string>) {
  let rocLangFile = null;

  try {
    // This will return the path of roc-lang's exports: { ".": ... } file
    rocLangFile = require.resolve("roc-lang");
  } catch (err) {
    throw new Error(rocNotFoundErr);
  }

  const rocBinaryPath = rocLangFile ? path.join(path.dirname(rocLangFile), "bin", "roc") : null;

  if (!rocBinaryPath || !fs.existsSync(rocBinaryPath)) {
    throw new Error(rocNotFoundErr);
  }

  const output = spawnSync(rocBinaryPath, args)

  if (output.status != 0) {
    const stdout = output.stdout.toString();
    const stderr = output.stderr.toString();
    const status = output.status === null ? `null, which means the subprocess terminated with a signal (in this case, signal ${output.signal})` : `code ${output.status}`

    throw new Error("`roc " + args.join(" ") + "` exited with status " + status + ". stdout was:\n\n" + stdout + "\n\nstderr was:\n\n" + stderr)
  }
}

const buildRocFile = (
  rocFilePath: string,
  addonPath: string,
  config: { cc: Array<string>; target: string; optimize: boolean },
) => {
  // The C compiler to use - e.g. you can specify `["zig" "cc"]` here to use Zig instead of the defualt `cc`.
  const cc = config.hasOwnProperty("cc") ? config.cc : ["cc"]
  const target = config.hasOwnProperty("target") ? config.target : ""
  const optimize = config.hasOwnProperty("optimize") ? config.optimize : ""

  const rocFileName = path.basename(rocFilePath)
  const rocFileDir = path.dirname(rocFilePath)
  const errors = []
  const buildingForMac = target.startsWith("macos") || (target === "" && os.platform() === "darwin")
  const buildingForLinux = target.startsWith("linux") || (target === "" && os.platform() === "linux")
  const tmpDir = os.tmpdir()
  const rocBuildOutputDir = fs.mkdtempSync(`${tmpDir}${path.sep}`)
  const targetSuffix = (target === "" ? "native" : target)
  const rocBuildOutputFile = path.join(rocBuildOutputDir, rocFileName.replace(/\.roc$/, `-${targetSuffix}.o`))

  // Build the initial Roc object binary for the current OS/architecture.
  //
  // This file may be rebuilt and overridden by a later build step (e.g. when running `yarn package`), but without having
  // some object binary here at this step, `node-gyp` (which `npm install`/`yarn install` run automatically, and there's
  // no way to disable it) will fail when trying to build the addon, because it will be looking for an object
  // binary that isn't there.
  runRoc(
    [
      "build",
      target === "" ? "" : `--target=${target}`,
      optimize ? "--optimize" : "",
      "--no-link",
      "--output",
      rocBuildOutputFile,
      rocFilePath
    ].filter((part) => part !== ""),
  )

  // TODO this is only necessary until `roc glue` can be run on app modules; once that exists,
  // we should run glue on the app .roc file and this can go away.
  const rocPlatformMain = path.join(rocFileDir, "platform", "main.roc")

  // Generate the C glue
  runRoc(["glue", path.join(__dirname, "node-glue.roc"), rocFileDir, rocPlatformMain])

  // Create the .d.ts file. By design, our glue should output the same .d.ts file regardless of sytem architecture.
  const typedefs =
    // TODO don't hardcode this, but rather generate it using `roc glue`
    `// This file was generated by the esbuild-roc plugin,
// based on the types in the .roc file that has the same
// path as this file but without the .d.ts at the end.
//
// This will be regenerated whenever esbuild runs.

type JsonValue = boolean | number | string | null | JsonArray | JsonObject
interface JsonArray extends Array<JsonValue> {}
interface JsonObject {
  [key: string]: JsonValue
}

// Currently, this function takes whatever you pass it and serializes it to JSON
// for Roc to consume, and then Roc's returned answer also gets serialized to JSON
// before JSON.parse gets called on it to convert it back to a TS value.
//
// This is an "80-20 solution" to get us a lot of functionality without having to
// wait for the nicer version to be implemented. The nicer version would not use
// JSON as an intermediary, and this part would specify the exact TS types needed
// to call the Roc function, based on the Roc function's actual types.
export function callRoc<T extends JsonValue, U extends JsonValue>(input: T): U
  `

  fs.writeFileSync(rocFilePath + ".d.ts", typedefs, "utf8")

  // Link the compiled roc binary into a native node addon. This replaces what binding.gyp would do in most
  // native node addons, except it can works cross-OS (if { cc: ["zig", "cc"] } is used for the config)
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
  // what cc and g++ commands it's doing; this is much nicer than strace output because they
  // spawn these processes with mmap and clone3 rather than exceve, so you can't really see
  // what the arguments to cc and g++ are from there.
  //
  // Then basically swap cc for zig cc -target x86_64-linux-gnu, g++ for zig c++ -target x86_64-linux-gnu,
  // and adjust the input/output directories as needed.

  // This script is a way to build Native Node Addons without using node-gyp.
  // It supports using Zig for cross-platform builds, which enables:
  // - Faster builds than node-gyp, which spawns a Python process that generates a Makefile which then runs cc and g++.
  // - Building native Node Addons for a given target operating system, without needing to use something like Docker.
  //   We need this so that we can build Roc addons for Node locally on Apple Silicon developer machines and then ship the
  //   resulting artifact (inside a zip bundle) directly to an x64 Linux Lambda with no builds taking place on the Labmda.
  //   We did not want to use Docker for this primarily because of licensing issues, but this also runs faster than building
  //   on x64 emulation (e.g. using either Docker or podman + qemu).

  // For now, these are hardcoded. In the future we can extract them into a function to call for multiple entrypoints.
  const ccTarget = target === "" ? "" : `--target=${ccTargetFromRocTarget(target)}`
  const cGluePath = path.join(__dirname, "node-to-roc.c")
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
  ]
    .map((suffix) => "-I" + path.join(includeRoot, suffix))
    .join(" ")

  const defines = [
    // TODO this should be dynamic, not hardcoded to "addon" - see:
    // https://nodejs.org/api/n-api.html#module-registration
    "NODE_GYP_MODULE_NAME=addon",
    "USING_UV_SHARED=1",
    "USING_V8_SHARED=1",
    "V8_DEPRECATION_WARNINGS=1",
    "V8_DEPRECATION_WARNINGS",
    "V8_IMMINENT_DEPRECATION_WARNINGS",
    "_GLIBCXX_USE_CXX11_ABI=1",
    "_DARWIN_USE_64_BIT_INODE=1",
    "_LARGEFILE_SOURCE",
    "_FILE_OFFSET_BITS=64",
    "__STDC_FORMAT_MACROS",
    "OPENSSL_NO_PINSHARED",
    "OPENSSL_THREADS",
    "BUILDING_NODE_EXTENSION",
  ]
    .map((flag) => "-D'" + flag + "'")
    .join(" ")

  const libraries = ["c", "m", "pthread", "dl", "util"].map((library) => "-l" + library)

  if (buildingForLinux) {
    // Linux requires -lrt
    libraries.push("-lrt")
  }

  const cmd = cc
    .concat([
      ccTarget === "" ? "" : ccTarget,
      "-o",
      addonPath,
      rocBuildOutputFile,
      cGluePath,
      defines,
      includes,
      "-fPIC",
      "-pthread",
      optimize ? "-O3" : "",
      // This was in the original node-gyp build, but it generates a separate directory.
      // (Maybe it also adds the symbols to the binary? Further investigation needed.)
      // buildingForMac ? "-gdwarf-2" : "",

      // Many roc hosts need aligned_alloc, which was added in macOS 10.15.
      buildingForMac ? "-mmacosx-version-min=10.15" : "",
      "-Wall",
      "-Wextra",
      "-Wendif-labels",
      "-W",
      "-Wno-unused-parameter",
      buildingForMac ? "-fno-strict-aliasing" : "-fno-omit-frame-pointer",
      buildingForMac ? "-Wl,-undefined,dynamic_lookup" : "",
      libraries.join(" "),
      buildingForLinux ? "-shared" : "",
    ])
    .flat()
    .filter((part) => part !== "")
    .join(" ")

  // Compile the node <-> roc C bridge and statically link in the .o binary (produced by `roc`)
  // into the .node addon binary
  execSync(cmd, { stdio: "inherit" })

  return { errors: [] }
}

module.exports = buildRocFile
