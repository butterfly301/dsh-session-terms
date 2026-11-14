const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerHooks } = require('node:module');
const root =
  process.env.DSH_VERIFY_MODULES ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
const parentURL = pathToFileURL(path.join(root, '..', '..', 'package.json')).href;
const load = (name) => import(pathToFileURL(path.join(root, name, 'lib/index.js')).href);

// The real application installs equivalent package fallback hooks during boot.
// This isolated test redirects shipped imports without editing node_modules.
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/') || specifier === 'zod')
      return next(specifier, { ...context, parentURL });
    return next(specifier, context);
  },
});

(async () => {
  const { Context } = await load('cordis');
  const { LlmAdapter, createUserMessage } = await load('dsh-llm');
  const host = await import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-terms-host-'));
  console.log('temporary storage', temp);
  const requests = [];
  async function open() {
    const ctx = new Context();
    for (const name of [
      'dsh-llm',
      'dsh-session',
      'dsh-session-projection',
      'dsh-system-prompt',
      'dsh-tools',
      'dsh-agent',
      'dsh-commands',
      'dsh-storage',
    ]) {
      const module = await load(name);
      await ctx.plugin(module.default ?? module, name === 'dsh-system-prompt' ? {} : undefined);
    }
    await ctx.plugin(await load('dsh-tool-executor-native'));
    await ctx.plugin(await load('dsh-storage-json'), { root: temp });
    await ctx.plugin(await load('dsh-storage-domain'), { backend: 'json' });
    class Mock extends LlmAdapter {
      async *stream(request) {
        requests.push(request);
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
    }
    ctx.llm.registerAdapter(['host-validation'], new Mock());
    await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
    await ctx.plugin(host);
    return ctx;
  }
  let ctx;
  const makeAgent = async (ctx, id) =>
    ctx.agents.create({
      sessionId: id,
      agentOptions: { provider: 'host-validation', model: 'local' },
    });
  const command = async (ctx, agent, action, payload = {}, sessionId = agent.session.id) => {
    const execution = await ctx.commands.execute(
      agent,
      '/session-terms ' + JSON.stringify({ sessionId, action, payload }),
      [],
      new AbortController().signal,
    );
    assert(execution, 'command must be registered');
    assert.equal(execution.result.kind, 'success', execution.result.text);
    return JSON.parse(execution.result.text);
  };
  try {
    ctx = await open();
    const errors = [];
    ctx.on('agent/error', (event) => errors.push(event.error));
    const a = await makeAgent(ctx, 'session/A:测试'),
      b = await makeAgent(ctx, 'session-B');
    const created = await command(ctx, a.agent, 'create', {
      name: '灯塔',
      note: '登录服务重构项目的代称',
    });
    assert.equal(created.ok, true);
    assert.equal(created.state.terms.length, 1);
    assert.equal((await command(ctx, b.agent, 'get')).state.terms.length, 0);
    assert.equal((await command(ctx, a.agent, 'clear', {}, 'session-B')).ok, false);
    const duplicate = await command(ctx, a.agent, 'create', { name: '灯塔', note: '不得覆盖' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.code, 'duplicate-name');
    await command(ctx, a.agent, 'setExpanded', { expanded: true });
    const schemas = ctx.tools.schemas(a.agent);
    assert(schemas.some((schema) => schema.name === 'session_terms_lookup'));
    assert.deepEqual(
      schemas.map((schema) => schema.name),
      ['session_terms_lookup'],
    );
    const before = requests.length;
    a.agent.followup(
      createUserMessage({
        source: { kind: 'user' },
        content: [{ type: 'text', text: '灯塔进度' }],
      }),
    );
    await a.agent.whenIdle();
    assert.equal(errors.length, 0, errors.map((e) => e.stack).join('\n'));
    assert.equal(requests.length, before + 1);
    assert.equal(
      requests.at(-1).messages.filter((message) => message.source?.kind === 'session-terms').length,
      1,
    );
    // UI command data must stay outside model-visible messages.
    assert(
      !requests.at(-1).messages.some((message) => JSON.stringify(message).includes('不得覆盖')),
    );
    await a.dispose();
    await b.dispose();
    await ctx.fiber.dispose();
    ctx = undefined;
    ctx = await open();
    const restored = await makeAgent(ctx, 'session/A:测试');
    const state = (await command(ctx, restored.agent, 'get')).state;
    assert.equal(state.terms[0].name, '灯塔');
    assert.equal(state.terms[0].note, '登录服务重构项目的代称');
    assert.equal(state.expanded, true);
    const fork = await makeAgent(ctx, 'fork-new-session');
    assert.equal((await command(ctx, fork.agent, 'get')).state.terms.length, 0);
    await fork.dispose();
    await restored.dispose();
    console.log(
      'PASS real Host commands, isolation, read-only tool, model admission and durable reopen',
    );
  } finally {
    await ctx?.fiber.dispose();
    assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir()));
    assert(path.basename(temp).startsWith('dsh-terms-host-'));
    await fs.rm(temp, { recursive: true, force: true });
    try {
      await fs.access(temp);
      throw Error('temporary storage remains');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    console.log('temporary storage removed', temp);
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
