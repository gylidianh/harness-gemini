const path = require('node:path');
const rcedit = require('rcedit');
module.exports = async context => {
  if (context.electronPlatformName !== 'win32') return;
  const info = context.packager.appInfo;
  await rcedit(path.join(context.appOutDir, `${info.productFilename}.exe`), {
    'file-version': info.version,
    'product-version': info.version,
    icon: path.resolve(__dirname, '../app/build/icon.ico'),
    'version-string': { ProductName: 'Harness Gemini', FileDescription: 'Harness Gemini' },
  });
};
