// oxlint-disable-next-line typescript/no-require-imports -- a webpack loader is CommonJS.
const patches = require('./playsvideo-patches.json');
module.exports = function (code) {
  const file = this.resourcePath.replaceAll('\\', '/').split('/playsvideo/dist/')[1];
  for (const { find, replace, count } of patches[file] ?? []) {
    if (code.split(find).length - 1 !== count) throw new Error(`playsvideo ${file}: expected ${count} occurrences of the patched source`);
    code = code.replaceAll(find, replace);
  }
  return code;
};
