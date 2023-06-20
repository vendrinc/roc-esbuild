import { callRoc } from './main.roc'

try {
    callRoc("Hello from TypeScript")

    // We should not have reached this point!
    process.exit(1)
}
catch(err) {
    console.log("This is a test of Roc's error handling, and we successfully caught this error from Roc:", err);
}
