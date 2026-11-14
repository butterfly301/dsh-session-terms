'use strict';

// Run with the installed Electron runtime. Uses the same public compatibility
// evaluator as Plugin Manager, without exemptions or profile mutations.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { installedClientSources } = require('./installed-client-sources.cjs');

const host = installedClientSources();
const { evaluatePluginCompatibility, getDshRuntimeVersion } = host.runtime(
  '@deepseek-ai/dsh-app-boot',
);
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const runtime = getDshRuntimeVersion();
assert.equal(
  evaluatePluginCompatibility(manifest, {}, runtime),
  undefined,
  `Plugin Manager must load the plugin on installed DSH ${runtime} without an exemption`,
);
for (const version of ['0.2.2-rc.1', '0.2.2-rc.3', '0.2.2', '0.2.3']) {
  assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, version);
  assert.equal(
    evaluatePluginCompatibility({ ...manifest, engines: {} }, {}, version),
    undefined,
    `Host peer requirements must also accept ${version}`,
  );
}
for (const version of ['0.2.1', '0.3.0-alpha.1', '0.3.0', '1.0.0'])
  assert.ok(evaluatePluginCompatibility(manifest, {}, version), version);
for (const dependency of manifest.dsh.client.inject) {
  assert.ok(
    dependency.startsWith('@deepseek-ai/'),
    `Client prerequisite must use its canonical graph id: ${dependency}`,
  );
  const actual = host.runtime(`${dependency}/package.json`);
  assert.equal(actual.name, dependency);
}
console.log(
  JSON.stringify({
    passed: true,
    runtime,
    range: manifest.engines.dsh,
    scope:
      'actual installed Plugin Manager compatibility evaluator; no exemptions or profile changes',
  }),
);
