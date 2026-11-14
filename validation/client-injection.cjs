const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const root =
  process.env.DSH_VERIFY_MODULES ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';

(async () => {
  const { Context } = await import(pathToFileURL(path.join(root, 'cordis/lib/index.js')).href);
  let contribution;
  // Only load the module declaration. No DOM or React renderer is emulated.
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'client.js'), 'utf8'), {
    window: {
      __ModuleLoader__: {
        load(value) {
          contribution = value;
        },
      },
    },
  });
  const client = contribution.factory((name) => {
    assert.equal(name, 'react');
    return {};
  });
  const ctx = new Context();
  try {
    await ctx.plugin({
      apply(provider) {
        const commands = { execute: () => 'command-service-reached' };
        for (const name of new Set([...client.inject, 'remote', 'remote.commands'])) {
          provider.provide(
            name,
            name === 'remote' ? { commands } : name === 'remote.commands' ? commands : {},
          );
        }
      },
    });
    let observed;
    const mounted = await ctx.plugin({
      inject: client.inject,
      apply(child) {
        try {
          const nested = child.remote.commands.execute();
          const service = child['remote.commands'].execute();
          assert.equal(nested, 'command-service-reached');
          assert.equal(service, nested);
          observed = nested;
        } catch (error) {
          observed = error;
        }
      },
    });
    if (observed instanceof Error) throw observed;
    assert.equal(
      observed,
      'command-service-reached',
      'both parent and command service must be accessible',
    );
    console.log('PASS real Cordis injection admits remote.commands for client declaration');
  } finally {
    await ctx.fiber.dispose();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
