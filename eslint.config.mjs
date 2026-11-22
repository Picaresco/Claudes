// Reglas de ESLint (npm run lint). Cada carpeta tiene su entorno: el proceso principal,
// los scripts y las pruebas corren en Node; la interfaz, en el navegador y con módulos.
import js from '@eslint/js';
import globals from 'globals';

export default [
  // .claude/ son ajustes y scripts personales de Claude Code (fuera de git): no se revisan.
  { ignores: ['node_modules/', 'dist/', 'publicar/', '.claude/'] },
  js.configs.recommended,
  {
    rules: {
      // Un nombre sin usar suele ser un resto de algo que se quitó. Los que empiezan
      // por «_» se dejan: son parámetros que hay que recibir aunque no se usen.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      // Los catch vacíos del proyecto llevan un comentario que dice por qué se ignora el fallo.
      'no-empty': ['error', { allowEmptyCatch: false }],
      // Quitar caracteres de control de nombres de archivo y cadenas es intencionado.
      'no-control-regex': 'off',
    },
  },
  {
    // Proceso principal, puente, pruebas y scripts sueltos: Node con require().
    files: ['src/main/**/*.js', 'src/preload/**/*.js', 'test/**/*.js', 'scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
  },
  {
    // Scripts con import/export (y este archivo).
    files: ['scripts/**/*.mjs', 'eslint.config.mjs'],
    languageOptions: { sourceType: 'module', globals: { ...globals.node } },
  },
  {
    // La interfaz: módulos del navegador. xterm y sus complementos llegan por <script>.
    files: ['src/renderer/renderer.js', 'src/renderer/ui/**/*.js'],
    languageOptions: {
      sourceType: 'module',
      globals: { ...globals.browser, Terminal: 'readonly', FitAddon: 'readonly', WebLinksAddon: 'readonly', UnicodeGraphemesAddon: 'readonly' },
    },
  },
  {
    // La animación de arranque es un script clásico que deja window.ClaudHomeSplash.
    files: ['src/renderer/splash.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
  },
];
