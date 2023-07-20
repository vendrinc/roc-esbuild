const buildRocFile = require('../src/build-roc.js');
const path = require('path');

module.exports = {
    process(sourceText, sourcePath, options) {
        const addonPath = path.join(path.dirname(sourcePath), "addon.node")
        buildRocFile(
            sourcePath,
            addonPath,
            {} // { cc: Array<string>; target: string; optimize: boolean },
        );

        return {
          code: `const addon = require(${JSON.stringify(addonPath)}); module.exports = addon;`,
        };
    },
};
