"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var main_roc_1 = require("./main.roc");
try {
    (0, main_roc_1.callRoc)("Hello from TypeScript");
    // We should not have reached this point!
    process.exit(1);
}
catch (err) {
    console.log("This is a test of Roc's error handling, and we successfully caught this error from Roc:", err);
}
