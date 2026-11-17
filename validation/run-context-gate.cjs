const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');

const runtimeRoot =
  process.env.DSH_VERIFY_MODULES ||
  'D:/Program Files/DeepSeek Harness/resources/app.asar/dsh/node_modules/@deepseek-ai';
const installedRequire = createRequire(path.join(runtimeRoot, 'dsh', 'package.json'));
const load = (name) => import(pathToFileURL(installedRequire.resolve(`@deepseek-ai/${name}`)).href);
const textOf = (message) =>
  message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
const countNotes = (request) =>
  request.messages.filter((message) => message.source?.kind === 'session-terms').length;
const results = [];

async function main() {
  const { Context } = await load('cordis');
  const { LlmAdapter, createUserMessage, createSystemMessage } = await load('dsh-llm');
  const { Session } = await load('dsh-session');
  const { installContextGate } = await import(
    pathToFileURL(path.join(__dirname, 'context-gate.mjs')).href
  );
  let sequence = 0;

  async function fixture(run) {
    const ctx = new Context();
    const errors = [],
      requests = [],
      commits = [];
    let handle, gate;
    const controls = { prepare: undefined, response: undefined };
    const terms = [{ id: 'lighthouse', version: 1, name: '灯塔', note: '登录服务重构项目的代称' }];
    try {
      ctx.on('agent/error', (event) => errors.push(event.error));
      ctx.on('session/event', (session, event) => commits.push({ session: session.id, event }));
      for (const name of [
        'dsh-llm',
        'dsh-session',
        'dsh-session-projection',
        'dsh-system-prompt',
        'dsh-tools',
        'dsh-agent',
      ]) {
        await ctx.plugin((await load(name)).default, name === 'dsh-system-prompt' ? {} : undefined);
      }
      await ctx.plugin(await load('dsh-tool-executor-native'));
      class Mock extends LlmAdapter {
        async prepareCall(provider, model, signal) {
          const call = await super.prepareCall(provider, model, signal);
          await controls.prepare?.();
          return call;
        }
        async *stream(request) {
          requests.push(
            JSON.parse(
              JSON.stringify({
                messages: request.messages,
                provider: request.provider,
                model: request.model,
              }),
            ),
          );
          if (controls.response) {
            const response = controls.response;
            controls.response = undefined;
            yield* response(request);
            return;
          }
          yield { type: 'text-delta', index: 0, text: 'ok' };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
      ctx.llm.registerAdapter(['terms-validation'], new Mock());
      await ctx.plugin((await load('dsh-agent-loop')).default, { agents: [] });
      handle = await ctx.agents.create({
        sessionId: `terms-validation-${++sequence}`,
        agentOptions: { provider: 'terms-validation', model: 'local' },
        setup(_ctx, agent) {
          gate = installContextGate(agent, () => terms);
        },
      });
      const agent = handle.agent;
      async function send(text) {
        const before = requests.length;
        agent.followup(
          createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
        );
        await agent.whenIdle();
        assert.equal(errors.length, 0, errors.map((error) => error.stack).join('\n'));
        assert(requests.length > before, 'a real loop request must reach the mock adapter');
        return requests.at(-1);
      }
      function compact(text = '历史摘要，只保留任务进度。') {
        const events = agent.session.snapshotEvents(); // Test-only raw log reader.
        const nodes = agent.session.surface.nodes.filter(
          (seq) => events[seq].type !== 'system/message',
        );
        if (!nodes.length) return;
        agent.session.append(
          'user/message',
          createUserMessage({ source: { kind: 'compaction' }, content: [{ type: 'text', text }] }),
          {
            surfaceOp: { op: 'replace', startSeq: nodes[0], endSeq: nodes.at(-1) },
            sourceEventSeqs: [...nodes],
          },
        );
      }
      await run({
        ctx,
        agent,
        gate,
        terms,
        controls,
        requests,
        commits,
        send,
        compact,
        createUserMessage,
        createSystemMessage,
        Session,
        defineTool: (await load('dsh-tools')).defineTool,
      });
      assert.equal(errors.length, 0, errors.map((error) => error.stack).join('\n'));
    } finally {
      await gate?.dispose();
      await handle?.dispose();
      await ctx.fiber.dispose();
    }
  }
  async function test(name, run) {
    const start = performance.now();
    try {
      await fixture(run);
      const result = { name, passed: true, milliseconds: Math.round(performance.now() - start) };
      results.push(result);
      console.log('PASS', name);
    } catch (error) {
      results.push({ name, passed: false, error: error.stack });
      console.error('FAIL', name, error.stack);
    }
  }

  await test('新增不立即注入，首次命中提供备注', async ({ agent, gate, send }) => {
    assert.equal(gate.state.appended, 0);
    assert.equal(agent.session.deriveMessages().length, 0);
    const request = await send('灯塔进度怎么样');
    assert.equal(countNotes(request), 1);
    assert.equal(gate.state.appended, 1);
    assert(request.messages.some((message) => textOf(message).includes('登录服务重构项目的代称')));
  });
  await test('连续三轮命中同版本不重复追加', async ({ gate, send }) => {
    for (let i = 0; i < 3; i++) assert.equal(countNotes(await send(`灯塔第${i}次讨论`)), 1);
    assert.equal(gate.state.appended, 1);
  });
  await test('仅修改颜色不重复提供备注，压缩后仍补回当前备注', async ({
    gate,
    terms,
    send,
    compact,
  }) => {
    await send('灯塔');
    terms[0] = { ...terms[0], color: '#2868b4', version: 2 };
    const request = await send('灯塔');
    assert.equal(gate.state.appended, 1);
    assert.equal(countNotes(request), 1);
    const note = request.messages.find((message) => message.source?.kind === 'session-terms');
    assert.equal(note.source.termId, terms[0].id);
    assert.equal(textOf(note), '灯塔\n登录服务重构项目的代称');
    assert.equal(textOf(note).includes(terms[0].id), false);
    compact();
    assert.equal(countNotes(await send('灯塔')), 1);
    assert.equal(gate.state.appended, 2);
  });
  await test('修改备注后提供新版本，后续不重复追加', async ({ gate, terms, send }) => {
    await send('灯塔');
    terms[0] = { ...terms[0], version: 2, note: '新版登录与账号服务重构' };
    const request = await send('灯塔');
    assert.equal(gate.state.appended, 2);
    assert.equal(countNotes(request), 2);
    assert(
      textOf(
        request.messages.filter((message) => message.source?.kind === 'session-terms').at(-1),
      ).includes('新版登录'),
    );
    await send('灯塔');
    assert.equal(gate.state.appended, 2);
  });
  await test('备注改回原内容时仍提供当前含义且不暴露版本号', async ({ gate, terms, send }) => {
    const original = terms[0].note;
    await send('灯塔');
    terms[0] = { ...terms[0], version: 2, note: '临时改为另一个含义' };
    await send('灯塔');
    terms[0] = { ...terms[0], version: 3, note: original };
    const request = await send('灯塔');
    const notes = request.messages.filter((message) => message.source?.kind === 'session-terms');
    assert.equal(gate.state.appended, 3);
    assert.equal(textOf(notes.at(-1)), `灯塔\n${original}`);
    for (const note of notes) assert.equal(textOf(note).startsWith('{'), false);
    await send('灯塔');
    assert.equal(gate.state.appended, 3);
  });
  await test('两轮之间压缩移除备注后重新提供', async ({ gate, send, compact }) => {
    await send('灯塔');
    compact();
    const request = await send('灯塔');
    assert.equal(countNotes(request), 1);
    assert.equal(gate.state.appended, 2);
  });
  await test('步骤准备后路由阶段压缩仍能补回备注', async ({ gate, controls, send, compact }) => {
    await send('灯塔');
    controls.prepare = () => {
      controls.prepare = undefined;
      compact();
    };
    const request = await send('灯塔');
    assert.equal(countNotes(request), 1);
    assert.equal(gate.state.appended, 2);
  });
  await test('请求失败后压缩并重试，重试请求补回备注', async ({
    ctx,
    gate,
    controls,
    requests,
    send,
    compact,
  }) => {
    ctx.on('agent/request-error', async (_event, _next) => {
      compact();
      return { kind: 'retry' };
    });
    controls.response = async function* () {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: { code: 'CONTEXT_WINDOW_EXCEEDED', message: 'fixture context overflow' },
        },
      };
    };
    const request = await send('灯塔');
    assert.equal(requests.length, 2);
    assert.equal(countNotes(requests[0]), 1);
    assert.equal(countNotes(request), 1);
    assert.equal(gate.state.appended, 2);
  });
  await test('其他动态背景更新不会重复追加术语', async ({ ctx, gate, send }) => {
    let value = 'A';
    ctx.systemPrompt.context({ name: 'fixture:changing', order: 1, text: () => value });
    await send('灯塔');
    value = 'B';
    await send('灯塔');
    value = 'C';
    await send('灯塔');
    assert.equal(gate.state.appended, 1);
  });
  await test('摘要仅保留标记与名称不能冒充完整备注', async ({ gate, send, compact }) => {
    await send('灯塔');
    compact('session-terms lighthouse version 1 灯塔');
    const request = await send('灯塔');
    assert.equal(countNotes(request), 1);
    assert.equal(gate.state.appended, 2);
  });
  await test('非命中消息不注入，删除后不再提供', async ({ gate, terms, send, compact }) => {
    assert.equal(countNotes(await send('普通消息')), 0);
    await send('灯塔');
    terms.length = 0;
    compact();
    assert.equal(countNotes(await send('灯塔')), 0);
    assert.equal(gate.state.appended, 1);
  });
  await test('只改名称和清空备注均产生新有效内容', async ({ gate, terms, send }) => {
    await send('灯塔');
    terms[0] = { ...terms[0], name: '灯塔计划', version: 2 };
    await send('灯塔');
    assert.equal(gate.state.appended, 1);
    await send('灯塔计划');
    assert.equal(gate.state.appended, 2);
    terms[0] = { ...terms[0], note: '', version: 3 };
    const request = await send('灯塔计划');
    const last = request.messages
      .filter((message) => message.source?.kind === 'session-terms')
      .at(-1);
    assert.equal(textOf(last), '灯塔计划');
    assert.equal(gate.state.appended, 3);
  });
  await test('取消发生在异步请求准备阶段时不注入', async ({
    agent,
    gate,
    controls,
    requests,
    createUserMessage,
  }) => {
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    controls.prepare = async () => {
      entered();
      await wait;
    };
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '灯塔' }] }),
    );
    await started;
    agent.cancel({ kind: 'user' });
    release();
    await agent.whenIdle();
    assert.equal(gate.state.appended, 0);
    assert.equal(requests.length, 0);
  });
  await test('会话日志可重建相同模型消息', async ({ agent, send, Session }) => {
    await send('灯塔');
    const seed = agent.session.snapshotEvents(); // Explicitly permitted in tests.
    const restored = Session.create(
      agent.session.id,
      seed,
      agent.session.header,
      agent.session.inheritedEventCount,
    );
    assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages());
  });
  await test('AI只读查询的完整结果可用于后续命中去重', async ({
    agent,
    gate,
    terms,
    controls,
    send,
    defineTool,
  }) => {
    agent.ctx.tools.register(
      defineTool({
        name: 'session_terms_lookup',
        description: 'Read this session term.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          const term = terms[0];
          return JSON.stringify({ id: term.id, name: term.name, note: term.note });
        },
      }),
    );
    controls.response = async function* () {
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'lookup-call',
        name: 'session_terms_lookup',
        argumentsDelta: '{}',
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await send('先查一下当前术语');
    assert.equal(gate.state.appended, 0);
    const request = await send('灯塔');
    assert.equal(gate.state.appended, 0);
    assert.equal(countNotes(request), 0);
    assert(
      request.messages.some(
        (message) => message.role === 'tool' && textOf(message).includes('登录服务重构'),
      ),
    );
  });
  await test('查询结果被剪枝后再次命中会补回完整备注', async ({
    agent,
    gate,
    terms,
    controls,
    send,
    defineTool,
  }) => {
    agent.ctx.tools.register(
      defineTool({
        name: 'session_terms_lookup',
        description: 'Read this session term.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          const term = terms[0];
          return JSON.stringify({ id: term.id, name: term.name, note: term.note });
        },
      }),
    );
    controls.response = async function* () {
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'pruned-lookup',
        name: 'session_terms_lookup',
        argumentsDelta: '{}',
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await send('查询当前术语');
    const event = agent.session.snapshotEvents().findLast((event) => event.type === 'tool/result');
    agent.session.append(
      'tool/result',
      {
        ...event.data,
        message: { ...event.data.message, content: [{ type: 'text', text: '结果已截断' }] },
      },
      {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      },
    );
    assert.equal(countNotes(await send('灯塔')), 1);
    assert.equal(gate.state.appended, 1);
  });
  await test('背景预览不应提交术语备注', async ({ ctx, agent, controls, send, compact }) => {
    await send('灯塔');
    controls.prepare = async () => {
      controls.prepare = undefined;
      compact();
      const before = agent.session.snapshotEvents().length;
      await ctx.systemPrompt.assemble({ agent, scope: agent });
      assert.equal(
        agent.session.snapshotEvents().length,
        before,
        'preview assembly must not mutate the session log',
      );
    };
    await send('灯塔');
  });
  await test('背景预览后取消不应留下未请求的术语备注', async ({
    ctx,
    agent,
    gate,
    controls,
    requests,
    send,
    compact,
    createUserMessage,
  }) => {
    await send('灯塔');
    const before = gate.state.appended;
    controls.prepare = async () => {
      controls.prepare = undefined;
      compact();
      await ctx.systemPrompt.assemble({ agent, scope: agent });
      agent.cancel({ kind: 'user' });
    };
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '灯塔' }] }),
    );
    await agent.whenIdle();
    assert.equal(requests.length, 1);
    assert.equal(gate.state.appended, before, 'cancelled preview must not append another term');
  });
  await test('复用当前请求信号的背景预览仍不提交术语', async ({
    ctx,
    agent,
    gate,
    controls,
    requests,
    send,
    compact,
    createUserMessage,
  }) => {
    await send('灯塔');
    let signal;
    ctx.on('agent/pre-step', (input, next) => {
      signal = input.signal;
      return next();
    });
    let previewAppends;
    controls.prepare = async () => {
      controls.prepare = undefined;
      compact();
      const before = agent.session.snapshotEvents().length;
      await ctx.systemPrompt.assemble({ agent, scope: agent, signal });
      previewAppends = agent.session.snapshotEvents().length - before;
      agent.cancel({ kind: 'user' });
    };
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '灯塔' }] }),
    );
    await agent.whenIdle();
    assert.equal(previewAppends, 0, 'assembly with the active signal must remain read-only');
    assert.equal(requests.length, 1);
    assert.equal(gate.state.appended, 1);
  });
  await test('保留其他步骤监听器声明的新请求序列', async ({ ctx, agent, send }) => {
    await send('普通消息');
    ctx.on('agent/pre-step', async (_input, next) => ({
      ...(await next()),
      startsRequestSeries: true,
    }));
    await send('灯塔');
    assert.equal(
      agent.session
        .snapshotEvents()
        .filter((event) => event.type === 'request/header' && event.data.reason === 'series')
        .length,
      1,
    );
  });
  await test('拒绝的步骤不提交术语也不发起模型请求', async ({
    ctx,
    agent,
    gate,
    requests,
    createUserMessage,
  }) => {
    ctx.on('agent/pre-step', () => ({ kind: 'reject' }));
    agent.followup(
      createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '灯塔' }] }),
    );
    await agent.whenIdle();
    assert.equal(requests.length, 0);
    assert.equal(gate.state.appended, 0);
    assert.equal(agent.session.deriveMessages().length, 0);
  });
  await test('inject 持久排队但不唤醒，也不将上下文当作用户命中', async ({
    agent,
    gate,
    requests,
    send,
    createUserMessage,
    Session,
  }) => {
    const message = createUserMessage({
      source: { kind: 'fixture-context' },
      content: [{ type: 'text', text: '灯塔上下文' }],
    });
    agent.inject(message);
    await agent.whenIdle();
    assert.equal(requests.length, 0);
    assert.equal(agent.session.deriveMessages().length, 0);
    assert.equal(agent.inbox.nextStep.length, 1);
    const request = await send('普通消息');
    assert(request.messages.some((entry) => entry.id === message.id));
    assert.equal(gate.state.appended, 0);
    const restored = Session.create(
      agent.session.id,
      agent.session.snapshotEvents(),
      agent.session.header,
      agent.session.inheritedEventCount,
    );
    assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages());
  });
  await test('请求准备中的 inject 仅进入后续步骤，不能替代最终准入检查', async ({
    agent,
    gate,
    controls,
    requests,
    send,
    createUserMessage,
  }) => {
    const message = createUserMessage({
      source: { kind: 'fixture-context' },
      content: [{ type: 'text', text: '灯塔上下文' }],
    });
    controls.prepare = () => {
      controls.prepare = undefined;
      agent.inject(message);
    };
    await send('普通消息');
    assert.equal(requests.length, 2);
    assert(!requests[0].messages.some((entry) => entry.id === message.id));
    assert(requests[1].messages.some((entry) => entry.id === message.id));
    assert.equal(gate.state.appended, 0);
  });
  await test('卸载发生在等待步骤决定期间时不再追加术语', async ({ ctx, gate, send }) => {
    ctx.on('agent/pre-step', async (_input, next) => {
      await gate.dispose();
      return next();
    });
    assert.equal(countNotes(await send('灯塔')), 0);
    assert.equal(gate.state.appended, 0);
    assert.equal(gate.state.active, false);
  });
  await test('卸载可重复调用并清除注册，重新安装后只注入一次', async ({
    agent,
    gate,
    terms,
    send,
    compact,
  }) => {
    await send('灯塔');
    await gate.dispose();
    await gate.dispose();
    compact();
    assert.equal(countNotes(await send('灯塔')), 0);
    const replacement = installContextGate(agent, () => terms);
    try {
      assert.equal(countNotes(await send('灯塔')), 1);
      assert.equal(gate.state.appended, 1);
      assert.equal(replacement.state.appended, 1);
    } finally {
      await replacement.dispose();
    }
  });
  await test('名称改回旧名称仍覆盖最近的完整含义，后续不重复追加', async ({
    gate,
    terms,
    send,
  }) => {
    const original = terms[0].name;
    await send(original);
    terms[0] = { ...terms[0], name: '灯塔计划', version: 2 };
    await send('灯塔计划');
    terms[0] = { ...terms[0], name: original, version: 3 };
    const request = await send(original);
    const notes = request.messages.filter((message) => message.source?.kind === 'session-terms');
    assert.equal(notes.length, 3);
    assert.equal(textOf(notes.at(-1)).split('\n')[0], original);
    await send(original);
    assert.equal(gate.state.appended, 3);
  });
  await test('首次仅注入命中的条目，用户粘贴完整载荷不能冒充已提供上下文', async ({
    gate,
    terms,
    send,
  }) => {
    terms.push({ id: 'harbor', version: 1, name: '港口', note: '另一个项目' });
    const request = await send(
      JSON.stringify({ id: terms[0].id, name: terms[0].name, note: terms[0].note }),
    );
    assert.equal(countNotes(request), 1);
    const note = request.messages.find((message) => message.source?.kind === 'session-terms');
    assert.equal(note.source.termId, terms[0].id);
    assert.equal(textOf(note).includes(terms[0].id), false);
    assert.equal(gate.state.appended, 1);
  });
  await test('不完整的只读查询结果不能代替完整备注', async ({
    agent,
    gate,
    terms,
    controls,
    send,
    defineTool,
  }) => {
    agent.ctx.tools.register(
      defineTool({
        name: 'session_terms_lookup',
        description: 'Read an incomplete session term.',
        parameters: {},
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        async execute() {
          return JSON.stringify({ id: terms[0].id, name: terms[0].name });
        },
      }),
    );
    controls.response = async function* () {
      yield {
        type: 'tool-call-delta',
        index: 0,
        id: 'incomplete-lookup',
        name: 'session_terms_lookup',
        argumentsDelta: '{}',
      };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
    };
    await send('查询当前术语');
    assert.equal(gate.state.appended, 0);
    assert.equal(countNotes(await send('灯塔')), 1);
    assert.equal(gate.state.appended, 1);
  });
  const report = {
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      dsh: installedRequire('@deepseek-ai/dsh/package.json').version,
      modules: runtimeRoot,
    },
    passed: results.filter((result) => result.passed).length,
    total: results.length,
    results,
  };
  if (process.env.DSH_VERIFY_REPORT)
    fs.writeFileSync(process.env.DSH_VERIFY_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, total: report.total }));
  if (report.passed !== report.total) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
