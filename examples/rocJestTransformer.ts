const buildRocFile = require('../src/build-roc');
const path = require('path');

import { TransformedSource, Transformer } from '@jest/transform';

const transformer: Transformer = {
    process(src: string, filename: string): TransformedSource {
        const addonPath = path.join(path.dirname(filename), "addon.node")
        buildRocFile(
            filename,
            addonPath,
            {} // { cc: Array<string>; target: string; optimize: boolean },
        );

        return {
            code: `const addon = require(${JSON.stringify(addonPath)}); module.exports = addon;`,
        }
    },
};

export default transformer;
