'use strict';

// Execute the installed TypeScript conversation logic with the shipped Cordis
// runtime. Only the unavailable browser-store notification utility is adapted.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { transformSync } = require('esbuild');

function installedClientSources() {
  const modules =
    process.env.DSH_VERIFY_MODULES ||
    path.dirname(
      process.env.DSH_INSTALL_DIR ||
        'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh',
    );
  const anchor = createRequire(path.join(modules, 'dsh/package.json'));
  const cache = new Map();
  const errors = [];
  const notifications = {
    notifySubscribers(listeners) {
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          errors.push(error);
        }
      }
    },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = transformSync(fs.readFileSync(file, 'utf8'), {
      loader: 'ts',
      format: 'cjs',
      target: 'es2023',
    }).code;
    const localRequire = (name) => {
      if (name === '@deepseek-ai/dsh-client-store') return notifications;
      if (name.startsWith('.')) return load(path.resolve(path.dirname(file), name));
      return anchor(name);
    };
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports);
    return module.exports;
  }
  return {
    errors,
    runtime: anchor,
    load(name, relative) {
      const root = path.dirname(anchor.resolve(`@deepseek-ai/${name}/package.json`));
      return load(path.join(root, relative));
    },
  };
}
module.exports = { installedClientSources };
