import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, cp, rm, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildClient, projectRoot } from '../scripts/build.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-terms-locale-test-'));
  console.log(`Temporary locale fixture: ${root}`);
  try {
    await cp(path.join(projectRoot, 'locale'), path.join(root, 'locale'), { recursive: true });
    await cp(path.join(projectRoot, 'src'), path.join(root, 'src'), { recursive: true });
    await run(root);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith('dsh-terms-locale-test-'));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
    console.log(`Removed locale fixture: ${root}`);
  }
}

test('client output is reproducible from external resources', async () => {
  const result = await buildClient(projectRoot, { write: false });
  assert.deepEqual(result.locales, ['en', 'zh']);
  assert.equal(result.output, await readFile(path.join(projectRoot, 'client.js'), 'utf8'));
  const source = await readFile(path.join(projectRoot, 'src/client.js'), 'utf8');
  assert(
    !/[\u3400-\u9fff]/u.test(source),
    'business source must not contain inline Chinese UI copy',
  );
  assert(source.includes("import resources from 'session-terms:locales'"));
  const styles = await readFile(path.join(projectRoot, 'src/client/styles.css'), 'utf8');
  assert(styles.includes('.st-btn:focus:not(:focus-visible)'));
  assert.deepEqual(
    result.resources.errorCodes,
    Object.keys(
      JSON.parse(await readFile(path.join(projectRoot, 'locale/en.json'), 'utf8')).errors,
    ).sort(),
  );
});

test('adding a third locale needs no business code change', async () =>
  fixture(async (root) => {
    const resource = JSON.parse(await readFile(path.join(root, 'locale/en.json'), 'utf8'));
    resource.ui.add = 'Ajouter';
    await writeFile(path.join(root, 'locale/fr.json'), JSON.stringify(resource));
    const before = await readFile(path.join(root, 'src/client.js'), 'utf8');
    const result = await buildClient(root, { write: false });
    assert(result.locales.includes('fr'));
    assert(result.output.includes('Ajouter'));
    const dictionaries = result.resources.dictionaries;
    assert.equal(dictionaries.fr.add, 'Ajouter');
    assert.equal(dictionaries.fr['errors.conflict'], resource.errors.conflict);
    assert(Object.values(dictionaries.fr).every((value) => typeof value === 'string'));
    assert.equal(await readFile(path.join(root, 'src/client.js'), 'utf8'), before);
  }));

test('missing translation keys fail the build', async () =>
  fixture(async (root) => {
    const file = path.join(root, 'locale/zh.json');
    const resource = JSON.parse(await readFile(file, 'utf8'));
    delete resource.ui.add;
    await writeFile(file, JSON.stringify(resource));
    await assert.rejects(buildClient(root, { write: false }), /Translation keys differ/);
  }));

test('placeholder mismatch fails the build', async () =>
  fixture(async (root) => {
    const file = path.join(root, 'locale/zh.json');
    const resource = JSON.parse(await readFile(file, 'utf8'));
    resource.ui.add += ' {name}';
    await writeFile(file, JSON.stringify(resource));
    await assert.rejects(buildClient(root, { write: false }), /Translation placeholders differ/);
  }));
