import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, copyFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { readLocales, translate } from '../src/i18n.mjs';
import { TermsError, changeState, emptyState, createTermsRepository } from '../src/terms.mjs';

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-host-i18n-'));
  try {
    return await run(root);
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert(basename(root).startsWith('dsh-host-i18n-'));
    await rm(root, { recursive: true, force: true });
    await assert.rejects(access(root), { code: 'ENOENT' });
  }
}

async function json(root, name, value) {
  await writeFile(join(root, `${name}.json`), JSON.stringify(value), 'utf8');
}

const hostKeys = [
  'commandDescription',
  'commandHint',
  'guidance',
  'lookupDescription',
  'noMatches',
];
const dictionary = (language) => ({
  meta: {},
  ui: {},
  errors: { 'invalid-name': `${language}:invalid-name` },
  host: Object.fromEntries(hostKeys.map((key) => [key, `${language}:${key}`])),
});

test('discovers external languages, skips config, and follows configured default', async () => {
  await withFixture(async (root) => {
    await json(root, 'config', { defaultLocale: 'fr-CA' });
    await json(root, 'en', dictionary('en'));
    await json(root, 'fr', dictionary('fr'));
    await json(root, 'es', dictionary('es'));
    await mkdir(join(root, 'de.json'));
    const resources = readLocales(root);
    assert.equal(resources.defaultLocale, 'fr-ca');
    assert.deepEqual([...resources.locales.keys()].sort(), ['en', 'es', 'fr']);
    assert.equal(translate(resources, 'host.guidance'), 'fr:guidance');
    assert.equal(translate(resources, 'host.guidance', 'es-MX'), 'es:guidance');
    assert.equal(translate(resources, 'host.guidance', 'unknown-invalid-tag'), 'fr:guidance');
    assert.equal(translate(resources, 'errors.invalid-name', 'es'), 'es:invalid-name');
    assert.throws(() => translate(resources, 'host.missing'), { message: 'missing-translation' });
  });
});

test('BCP 47 lookup keeps intermediate scripts and regions, then falls back per key', async () => {
  await withFixture(async (root) => {
    await json(root, 'config', { defaultLocale: 'en-US' });
    await json(root, 'en', dictionary('en'));
    await json(root, 'sr', dictionary('sr'));
    await json(root, 'sr-Latn', { host: { guidance: 'script', noMatches: '' } });
    await json(root, 'sr-Latn-RS', { host: { commandDescription: 'region' } });
    const resources = readLocales(pathToFileURL(`${root}/`));
    assert.equal(translate(resources, 'host.commandDescription', 'SR-latn-rs-u-nu-latn'), 'region');
    assert.equal(translate(resources, 'host.guidance', 'sr-Latn-RS'), 'script');
    assert.equal(
      translate(resources, 'host.lookupDescription', 'sr-Latn-RS'),
      'sr:lookupDescription',
    );
    assert.equal(translate(resources, 'host.noMatches', 'sr-Latn-RS'), '');
    assert.equal(translate(resources, 'host.guidance', '../../private'), 'en:guidance');
  });
});

test('missing config defaults to English and invalid resources fail explicitly', async () => {
  await withFixture(async (root) => {
    await json(root, 'en', dictionary('en'));
    assert.equal(readLocales(root).defaultLocale, 'en');
    await json(root, 'config', { defaultLocale: '../outside' });
    assert.throws(() => readLocales(root), { message: 'invalid-default-locale' });
    await json(root, 'config', { defaultLocale: 'en' });
    await json(root, 'es', []);
    assert.throws(() => readLocales(root), { message: 'invalid-locale-dictionary' });
  });
});

test('TermsError accepts only a code and every existing domain failure keeps its code', async () => {
  const sample = new TermsError('invalid-name', 'private underlying detail');
  assert.equal(sample.message, 'invalid-name');
  assert.equal(sample.code, 'invalid-name');
  const created = changeState(emptyState(), 'create', { name: 'one' });
  const item = created.terms[0];
  const cases = [
    ['create', { name: '' }, 'invalid-name'],
    ['create', { name: 'two', note: 1 }, 'invalid-note'],
    ['create', { name: 'two', color: 'red' }, 'invalid-color'],
    ['create', { name: 'one' }, 'duplicate-name'],
    ['delete', { id: 'gone' }, 'missing-term'],
    ['clear', { expectedRevision: -1 }, 'conflict'],
    ['restore', {}, 'invalid-restore'],
    ['restore', { term: { ...item, name: 'two' } }, 'duplicate-id'],
    ['reorder', { ids: [] }, 'invalid-order'],
    ['setExpanded', { expanded: 'yes' }, 'invalid-expanded'],
    ['unknown', {}, 'unknown-action'],
  ];
  for (const [action, payload, code] of cases) {
    assert.throws(
      () => changeState(created, action, payload),
      (error) => error instanceof TermsError && error.code === code && error.message === code,
    );
  }
  const repository = createTermsRepository({ get() {} });
  assert.throws(() => repository.get(''), { message: 'invalid-session', code: 'invalid-session' });
  await assert.rejects(repository.call('', 'get'), {
    message: 'invalid-session',
    code: 'invalid-session',
  });
});

// Minimal dependency doubles keep these protocol tests runnable with plain Node.
// Real Host integration remains covered by validation/run-host.cjs.
const zodDouble = `
const schema = (validate = () => true) => ({
  parse(value) { if (!validate(value)) throw Error('schema validation details'); return value; },
  min(size) { return schema(value => validate(value) && value.length >= size); },
  length(size) { return schema(value => validate(value) && value.length === size); },
  regex(pattern) { return schema(value => validate(value) && pattern.test(value)); },
  int() { return this; }, positive() { return this; }, nonnegative() { return this; },
  optional() { return schema(value => value === undefined || validate(value)); },
  nullable() { return schema(value => value === null || validate(value)); },
  strict() { return this; },
});
export const z = {
  string: () => schema(value => typeof value === 'string'),
  number: () => schema(), boolean: () => schema(), record: () => schema(), unknown: () => schema(),
  array: item => schema(value => {
    if (!Array.isArray(value)) return false;
    try { for (const entry of value) item.parse(entry); return true; } catch { return false; }
  }),
  enum: values => schema(value => values.includes(value)),
  object: fields => schema(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    if (Object.keys(value).some(key => !(key in fields))) return false;
    try { for (const key of Object.keys(fields)) fields[key].parse(value[key]); return true; } catch { return false; }
  }),
};`;
const asModule = (source) => `data:text/javascript,${encodeURIComponent(source)}`;

async function openHost(root, defaultLocale, openings = new Map()) {
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'locale'));
  await copyFile(new URL('../index.js', import.meta.url), join(root, 'index.mjs'));
  for (const name of ['terms.mjs', 'identity.mjs', 'color.mjs', 'matching.mjs', 'i18n.mjs'])
    await copyFile(new URL(`../src/${name}`, import.meta.url), join(root, 'src', name));
  await json(join(root, 'locale'), 'config', { defaultLocale });
  for (const language of ['en', 'fr', 'es'])
    await json(join(root, 'locale'), language, dictionary(language));
  const hostURL = pathToFileURL(join(root, 'index.mjs')).href;
  const doubles = {
    zod: zodDouble,
    '@deepseek-ai/dsh-storage-domain':
      'export const defineDomain = value => value; export const domainTable = value => value;',
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value;',
    './src/context.mjs': 'export const installContextGate = () => ({ dispose() {} });',
  };
  const hook = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL === hostURL && Object.hasOwn(doubles, specifier))
        return { url: asModule(doubles[specifier]), shortCircuit: true };
      return next(specifier, context);
    },
  });
  let host;
  try {
    host = await import(hostURL);
  } finally {
    hook.deregister();
  }
  const records = new Map();
  let failure;
  const table = {
    get(key) {
      if (failure) throw failure;
      return records.get(key);
    },
    async put(key, value) {
      if (failure) throw failure;
      records.set(key, value);
    },
  };
  let command, tool, section;
  const agent = {
    session: { id: 'session-A' },
    ctx: {
      effect(callback) {
        return callback();
      },
      systemPrompt: {
        section(value) {
          section = value;
          return () => {};
        },
      },
      tools: {
        register(value) {
          tool = value;
          return () => {};
        },
      },
    },
  };
  const ctx = new Proxy(
    {
      storageDomain: {
        async open() {
          return { table: () => table, close() {} };
        },
      },
      effect() {},
      on() {},
      commands: {
        register(value) {
          command = value;
        },
      },
      agents: { list: () => [agent] },
      sessionQuery: {
        async observeSession(sessionId) {
          const opening = openings.get(sessionId);
          return {
            events:
              opening === undefined
                ? []
                : [
                    {
                      type: 'user/message',
                      time: opening.time,
                      data: {
                        source: { kind: 'user' },
                        content: [{ type: 'text', text: opening.text }],
                      },
                    },
                  ],
            [Symbol.dispose]() {},
          };
        },
      },
      get(name) {
        return this[name];
      },
    },
    {
      get(target, key) {
        if (key === 'locale') throw Error('cannot get property locale without inject');
        return target[key];
      },
    },
  );
  await host.apply(ctx);
  return {
    command,
    tool,
    section,
    agent,
    domain: host.termsDomain,
    observe(sessionId, opening) {
      openings.set(sessionId, opening);
    },
    setFailure(error) {
      failure = error;
    },
  };
}

test('Host reads every description from the configured language without touching ctx.locale', async () => {
  await withFixture(async (root) => {
    const { command, tool, section, agent } = await openHost(root, 'es-MX');
    assert.equal(command.description, 'es:commandDescription');
    assert.equal(command.input.hint, 'es:commandHint');
    assert.equal(section.text, 'es:guidance');
    assert.equal(tool.description, 'es:lookupDescription');
    assert.deepEqual(tool.output.render({}, ''), [{ type: 'text', text: 'es:noMatches' }]);
    assert.deepEqual(tool.output.render({}, 'one\ntwo'), [
      { type: 'text', text: 'one' },
      { type: 'text', text: 'two' },
    ]);
    assert.equal(await tool.execute({}, {}), '');
    const result = JSON.parse(
      (await command.handler({ agent, rawInput: '{"action":"get"}' })).text,
    );
    assert.equal(result.ok, true);
  });
});

test('Host command accepts atomic multi-delete and enforces revision and session checks', async () => {
  await withFixture(async (root) => {
    const { command, agent } = await openHost(root, 'en');
    const request = async (input) =>
      JSON.parse((await command.handler({ agent, rawInput: JSON.stringify(input) })).text);
    let result;
    for (const name of ['A', 'B', 'C'])
      result = await request({ action: 'create', payload: { name } });
    const before = result.state;
    const ids = before.terms.slice(0, 2).map((term) => term.id);
    assert.deepEqual(
      await request({ sessionId: 'session-B', action: 'deleteMany', payload: { ids } }),
      { ok: false, code: 'session-mismatch' },
    );
    assert.deepEqual(
      await request({ action: 'deleteMany', payload: { ids, expectedRevision: -1 } }),
      { ok: false, code: 'conflict' },
    );
    assert.deepEqual(
      await request({ action: 'deleteMany', payload: { ids: [ids[0], 'missing'] } }),
      { ok: false, code: 'missing-term' },
    );
    assert.deepEqual((await request({ action: 'get' })).state, before);
    const deleted = await request({
      action: 'deleteMany',
      payload: { ids, expectedRevision: before.revision },
    });
    assert.equal(deleted.ok, true);
    assert.deepEqual(
      deleted.state.terms.map((term) => term.name),
      ['C'],
    );
    assert.equal(deleted.state.revision, before.revision + 1);
  });
});

test('Host stored term schema accepts legacy and nullable hex colors and rejects injection', async () => {
  await withFixture(async (root) => {
    const { domain } = await openHost(root, 'en');
    const schema = domain.tables.sessions;
    const entry = { id: 'old', name: 'legacy', note: '', version: 1, order: 0 };
    const state = (term) => ({ revision: 1, expanded: false, terms: [term] });
    for (const term of [entry, { ...entry, color: null }, { ...entry, color: '#aB12Ef' }])
      assert.deepEqual(schema.parse(state(term)), state(term));
    for (const color of ['', 'red', '#abc', '#12345678', '#abcdef\n', '#abcdef; color:red', 1, {}])
      assert.throws(() => schema.parse(state({ ...entry, color })));
  });
});

test('Host color commands preserve AI lookup output and return code-only validation and CAS failures', async () => {
  await withFixture(async (root) => {
    const { command, tool, agent } = await openHost(root, 'en');
    const request = async (action, payload) =>
      JSON.parse(
        (
          await command.handler({
            agent,
            rawInput: JSON.stringify({ action, payload }),
          })
        ).text,
      );
    const created = await request('create', { name: 'colored', note: 'context', color: '#ABCDEF' });
    assert.equal(created.ok, true);
    const entry = created.state.terms[0];
    assert.equal(entry.color, '#abcdef');
    const originalAI = await tool.execute({}, {});
    const updated = await request('update', { ...entry, color: '#123456', expectedVersion: 1 });
    assert.equal(updated.ok, true);
    assert.equal(updated.state.terms[0].version, 2);
    assert.equal(await tool.execute({}, {}), originalAI);
    assert.deepEqual(await request('update', { ...entry, color: null, expectedVersion: 1 }), {
      ok: false,
      code: 'conflict',
    });
    assert.deepEqual(
      await request('create', { name: 'invalid', color: 'red; background:url(x)' }),
      {
        ok: false,
        code: 'invalid-color',
      },
    );
    assert.deepEqual(await request('update', { ...updated.state.terms[0], color: '#123456\n' }), {
      ok: false,
      code: 'invalid-color',
    });
    const reset = await request('update', {
      ...updated.state.terms[0],
      color: null,
      expectedVersion: 2,
    });
    assert.equal(reset.state.terms[0].color, null);
    assert.equal(reset.state.terms[0].version, 3);
    assert.equal(await tool.execute({}, {}), originalAI);
  });
});

test('Host returns code-only failures and never leaks error messages or storage details', async () => {
  await withFixture(async (root) => {
    const host = await openHost(root, 'en');
    const request = async (value) => {
      const result = await host.command.handler({
        agent: host.agent,
        rawInput: typeof value === 'string' ? value : JSON.stringify(value),
      });
      assert.equal(result.kind, 'success');
      return JSON.parse(result.text);
    };
    for (const raw of [
      '{',
      'null',
      '[]',
      '{}',
      '{"action":"unknown"}',
      '{"action":"get","extra":true}',
    ]) {
      assert.deepEqual(await request(raw), { ok: false, code: 'invalid-request' });
    }
    assert.deepEqual(await request({ sessionId: 'session-B', action: 'clear' }), {
      ok: false,
      code: 'session-mismatch',
    });
    assert.deepEqual(await request({ action: 'create', payload: { name: '' } }), {
      ok: false,
      code: 'invalid-name',
    });
    assert.equal((await request({ action: 'create', payload: { name: 'one' } })).ok, true);
    assert.deepEqual(await request({ action: 'create', payload: { name: 'one' } }), {
      ok: false,
      code: 'duplicate-name',
    });
    for (const error of [
      new Error('E:/private/storage.json secret'),
      new SyntaxError('private JSON content'),
      Object.assign(new Error('private'), { name: 'TermsError', code: 'secret' }),
    ]) {
      host.setFailure(error);
      assert.deepEqual(await request({ action: 'get' }), { ok: false, code: 'operation-failed' });
    }
  });
});

test('Host shares one terms library across a conversation lineage and isolates other conversations', async () => {
  await withFixture(async (root) => {
    const opening = { time: 1794399990000, text: '把标题右上的图标换成调查图标' };
    const openings = new Map([
      ['session-A', opening],
      ['session-fork', opening],
      // Same text at a different moment: another conversation with its own library.
      ['session-other', { ...opening, time: opening.time + 1 }],
    ]);
    const { command, agent } = await openHost(root, 'en', openings);
    const request = async (action, payload) =>
      JSON.parse(
        (await command.handler({ agent, rawInput: JSON.stringify({ action, payload }) })).text,
      );

    assert.equal((await request('create', { name: 'RightUpImage' })).ok, true);

    agent.session.id = 'session-fork';
    assert.deepEqual(
      (await request('get')).state.terms.map((term) => term.name),
      ['RightUpImage'],
    );

    assert.equal((await request('create', { name: '闪切' })).ok, true);
    agent.session.id = 'session-A';
    assert.deepEqual(
      (await request('get')).state.terms.map((term) => term.name),
      ['RightUpImage', '闪切'],
    );

    agent.session.id = 'session-other';
    assert.deepEqual((await request('get')).state.terms, []);
  });
});

test('Host keeps session-scoped libraries when no conversation opening is readable', async () => {
  await withFixture(async (root) => {
    const { command, agent } = await openHost(root, 'en');
    const request = async (action, payload) =>
      JSON.parse(
        (await command.handler({ agent, rawInput: JSON.stringify({ action, payload }) })).text,
      );

    assert.equal((await request('create', { name: 'only-here' })).ok, true);
    agent.session.id = 'session-unreadable';
    assert.deepEqual((await request('get')).state.terms, []);
  });
});
