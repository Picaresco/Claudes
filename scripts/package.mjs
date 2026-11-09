// Empaqueta la app en dist/Claudes-win32-x64/Claudes.exe
// Uso: npm run package
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as packagerModule from '@electron/packager';

const packager = packagerModule.packager ?? packagerModule.default;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const icon = path.join(root, 'build', 'icon.ico');

const paths = await packager({
  dir: root,
  name: 'Claudes',
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  icon: fs.existsSync(icon) ? icon : undefined,
  // node-pty trae binarios y ejecutables auxiliares: tienen que quedar como archivos sueltos.
  asar: { unpackDir: 'node_modules/node-pty' },
  ignore: [
    /^\/dist($|\/)/,
    /^\/\.claude($|\/)/,
    /^\/scripts($|\/)/,
    /^\/README\.md$/,
    /^\/\.gitignore$/,
    /^\/node_modules\/node-pty\/(deps|src|third_party|scripts|typings|binding\.gyp)/,
    /^\/node_modules\/node-pty\/prebuilds\/(darwin|linux|win32-arm64)/,
    /\.pdb$/,
    /\.map$/,
  ],
  win32metadata: { FileDescription: 'Claudes', ProductName: 'Claudes' },
});

console.log('Empaquetado en:', paths.join(', '));
