import test from 'node:test';
import assert from 'node:assert/strict';
import { createTermsIdentity, lineageKey, selectFirstUserMessage } from '../src/identity.mjs';

const message = (time, text, kind = 'user') => ({
  type: 'user/message',
  time,
  data: { source: { kind }, content: [{ type: 'text', text }] },
});

test('谱系键对同一对话的开场稳定，对不同开场分离', () => {
  const opening = { time: 1, text: '开场白' };
  assert.equal(lineageKey(opening), lineageKey({ ...opening }));
  assert.match(lineageKey(opening), /^lineage:[A-Za-z0-9_-]{22}$/);
  assert.notEqual(lineageKey(opening), lineageKey({ time: 2, text: '开场白' }));
  assert.notEqual(lineageKey(opening), lineageKey({ time: 1, text: '另一句' }));
});

test('只取用户本人的第一条消息，文本块拼接后参与哈希', () => {
  const events = [
    message(5, 'reminder', 'system'),
    { type: 'assistant/message', time: 6, data: {} },
    {
      type: 'user/message',
      time: 7,
      data: {
        source: { kind: 'user' },
        content: [{ type: 'image' }, { type: 'text', text: '一' }, { type: 'text', text: '二' }],
      },
    },
  ];
  assert.deepEqual(selectFirstUserMessage(events), { time: 7, text: '一\n二' });
  assert.equal(selectFirstUserMessage([]), undefined);
  assert.equal(selectFirstUserMessage([message(5, 'x', 'system')]), undefined);
});

test('分叉复制前缀，因此与源会话得到同一个键', () => {
  const events = [message(3, '把图标换成调查图标'), { type: 'turn/start', time: 4, data: {} }];
  const forkSeed = [...events, { type: 'session/end-seed', time: 4, data: { inherited: true } }];
  assert.equal(
    lineageKey(selectFirstUserMessage(forkSeed)),
    lineageKey(selectFirstUserMessage(events)),
  );
});

test('解析器缓存已确认的谱系键，也只读一次日志', async () => {
  let reads = 0;
  const identity = createTermsIdentity({
    firstUserMessage: async () => {
      reads += 1;
      return { time: 42, text: '开场白' };
    },
  });
  assert.equal(identity.cachedKeyOf('s1'), undefined);
  const key = await identity.keyFor('s1');
  assert.equal(key, lineageKey({ time: 42, text: '开场白' }));
  assert.equal(await identity.keyFor('s1'), key);
  assert.equal(identity.cachedKeyOf('s1'), key);
  assert.equal(reads, 1);
});

test('并发解析共用一次日志读取', async () => {
  let reads = 0;
  const identity = createTermsIdentity({
    firstUserMessage: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { time: 7, text: '开场白' };
    },
  });
  const [first, second] = await Promise.all([identity.keyFor('s1'), identity.keyFor('s1')]);
  assert.equal(first, second);
  assert.equal(reads, 1);
});

test('尚无用户消息或日志不可读时退回会话键，且不缓存这个结果', async () => {
  let state = 'missing';
  const identity = createTermsIdentity({
    firstUserMessage: async () => {
      if (state === 'missing') return undefined;
      if (state === 'broken') throw new Error('log unavailable');
      return { time: 9, text: '后来的开场白' };
    },
  });
  assert.equal(await identity.keyFor('s1'), 'session:s1');
  assert.equal(identity.cachedKeyOf('s1'), undefined);
  state = 'broken';
  assert.equal(await identity.keyFor('s1'), 'session:s1');
  assert.equal(identity.cachedKeyOf('s1'), undefined);
  state = 'ready';
  assert.equal(await identity.keyFor('s1'), lineageKey({ time: 9, text: '后来的开场白' }));
});

test('会话释放后丢弃缓存', async () => {
  const identity = createTermsIdentity({
    firstUserMessage: async () => ({ time: 1, text: '开场白' }),
  });
  await identity.keyFor('s1');
  identity.forget('s1');
  assert.equal(identity.cachedKeyOf('s1'), undefined);
});
