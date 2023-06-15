const path = require("path")
const { execSync } = require("child_process")

const includePath = path.resolve(process.execPath, "..", "..", "include", "node")

execSync("clang-tidy src/*.c -- -I" + includePath, { stdio: "inherit" })
