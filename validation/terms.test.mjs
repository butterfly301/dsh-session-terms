import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchTerms,
  changeState,
  emptyState,
  createTermsRepository,
  renderTerm,
} from '../src/terms.mjs';

const term = (id, name) => ({ id, name, note: '', version: 1, order: 0 });

test('模型术语背景不含内部版本号，备注更新后输出随之更新', () => {
  const created = changeState(emptyState(), 'create', { name: '电梯', note: '给星星挠痒的东西' });
  const original = created.terms[0];
  assert.deepEqual(JSON.parse(renderTerm(original)), {
    id: original.id,
    name: '电梯',
    note: '给星星挠痒的东西',
  });
  const updated = changeState(created, 'update', {
    id: original.id,
    name: '电梯',
    note: '给月亮梳头的工具',
  }).terms[0];
  assert.equal(updated.version, 2);
  assert.notEqual(renderTerm(updated), renderTerm(original));
  assert.equal(Object.hasOwn(JSON.parse(renderTerm(updated)), 'version'), false);
});

test('中文长词优先，独立短词仍命中，同条去重', () => {
  const terms = [term('short', '灯塔'), term('long', '灯塔计划')];
  assert.deepEqual(
    matchTerms('灯塔计划开始了', terms).map((term) => term.id),
    ['long'],
  );
  assert.deepEqual(
    matchTerms('灯塔计划开始了，灯塔还要讨论。灯塔', terms).map((term) => term.id),
    ['short', 'long'],
  );
});

test('英文按完整单词且区分大小写，特殊符号按原文匹配', () => {
  const terms = [term('api', 'API'), term('cpp', 'C++'), term('digits', '123')];
  assert.deepEqual(matchTerms('CAPITAL api APIClient x1234', terms), []);
  assert.deepEqual(
    matchTerms('API 接口，C++，编号 123。', terms).map((term) => term.id),
    ['api', 'cpp', 'digits'],
  );
});

test('名称唯一，修正空白，备注和名称变更更新版本', () => {
  const created = changeState(emptyState(), 'create', { name: ' 灯塔 ', note: '备注' });
  assert.equal(created.terms[0].name, '灯塔');
  assert.throws(
    () => changeState(created, 'create', { name: '灯塔' }),
    (error) => error.code === 'duplicate-name',
  );
  const updated = changeState(created, 'update', {
    id: created.terms[0].id,
    name: '灯塔计划',
    note: '',
  });
  assert.equal(updated.terms[0].version, 2);
  assert.equal(updated.terms[0].note, '');
  assert.equal(created.terms[0].note, '备注');
  assert.equal(
    changeState(updated, 'update', { id: updated.terms[0].id, name: '灯塔计划', note: '' }),
    updated,
  );
});

test('编辑版本基线独立于库修订号，过期编辑拒绝且保持向后兼容', () => {
  const original = changeState(emptyState(), 'create', { name: 'A', note: 'original' });
  const entry = original.terms[0];
  const unrelated = changeState(original, 'create', { name: 'B' });
  const updated = changeState(unrelated, 'update', {
    id: entry.id,
    name: 'A',
    note: 'edited',
    expectedRevision: unrelated.revision,
    expectedVersion: entry.version,
  });
  assert.equal(updated.terms[0].version, 2);
  assert.equal(updated.terms[1].name, 'B');
  const before = structuredClone(updated);
  for (const expectedVersion of [1, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, '2']) {
    assert.throws(
      () =>
        changeState(updated, 'update', {
          id: entry.id,
          name: '',
          note: null,
          expectedRevision: updated.revision,
          expectedVersion,
        }),
      { code: 'conflict' },
    );
    assert.deepEqual(updated, before);
  }
  assert.throws(
    () =>
      changeState(updated, 'update', {
        id: entry.id,
        name: 'A',
        note: 'edited',
        expectedVersion: 1,
      }),
    { code: 'conflict' },
  );
  assert.equal(
    changeState(updated, 'update', { id: entry.id, name: 'A', note: 'legacy' }).terms[0].note,
    'legacy',
  );
});

test('删除与撤销保留原词条身份，非法排序及冲突拒绝', () => {
  const first = changeState(emptyState(), 'create', { name: 'A' });
  const second = changeState(first, 'create', { name: 'B' });
  const removed = changeState(second, 'delete', { id: second.terms[0].id });
  const restored = changeState(removed, 'restore', { term: second.terms[0], index: 0 });
  assert.deepEqual(restored.terms, second.terms);
  assert.throws(
    () => changeState(restored, 'reorder', { ids: [restored.terms[0].id, restored.terms[0].id] }),
    (error) => error.code === 'invalid-order',
  );
  assert.throws(
    () => changeState(restored, 'clear', { expectedRevision: 0 }),
    (error) => error.code === 'conflict',
  );
});

test('批量删除只移除所选词条，一次更新并保留其他词条顺序', () => {
  let state = emptyState();
  for (const name of ['A', 'B', 'C', 'D'])
    state = changeState(state, 'create', { name, note: name });
  const result = changeState(state, 'deleteMany', {
    ids: [state.terms[0].id, state.terms[2].id],
    expectedRevision: state.revision,
  });
  assert.deepEqual(
    result.terms.map((term) => [term.name, term.note, term.order]),
    [
      ['B', 'B', 0],
      ['D', 'D', 1],
    ],
  );
  assert.equal(result.revision, state.revision + 1);
  assert.equal(state.terms.length, 4);
  for (const ids of [undefined, [], [state.terms[0].id, state.terms[0].id], [null], ['']]) {
    assert.throws(() => changeState(state, 'deleteMany', { ids }), { code: 'invalid-selection' });
  }
  assert.throws(() => changeState(state, 'deleteMany', { ids: [state.terms[0].id, 'missing'] }), {
    code: 'missing-term',
  });
  assert.throws(
    () => changeState(state, 'deleteMany', { ids: [state.terms[0].id], expectedRevision: -1 }),
    { code: 'conflict' },
  );
});

test('批量删除保存失败时不会部分删除，重试只写入一次', async () => {
  const records = new Map();
  let fail = false;
  let writes = 0;
  const repository = createTermsRepository({
    get: (key) => records.get(key),
    async put(key, value) {
      if (fail) throw Error('disk unavailable');
      writes++;
      records.set(key, structuredClone(value));
    },
  });
  for (const name of ['A', 'B', 'C']) await repository.call('test', 'create', { name });
  const before = repository.get('test');
  const ids = before.terms.slice(0, 2).map((term) => term.id);
  fail = true;
  await assert.rejects(
    repository.call('test', 'deleteMany', { ids, expectedRevision: before.revision }),
    /disk unavailable/,
  );
  assert.deepEqual(repository.get('test'), before);
  fail = false;
  await repository.call('test', 'deleteMany', { ids, expectedRevision: before.revision });
  assert.equal(writes, 4);
  assert.deepEqual(
    repository.get('test').terms.map((term) => term.name),
    ['C'],
  );
});

test('并发新增不丢失，写入失败不发布状态，会话相互隔离', async () => {
  const records = new Map();
  let fail = false;
  const repository = createTermsRepository({
    get: (id) => records.get(id),
    async put(id, state) {
      await Promise.resolve();
      if (fail) throw Error('disk unavailable');
      records.set(id, structuredClone(state));
    },
  });
  await Promise.all([
    repository.call('A', 'create', { name: '灯塔' }),
    repository.call('A', 'create', { name: '灰盒' }),
  ]);
  assert.equal(repository.get('A').terms.length, 2);
  assert.equal(repository.get('B').terms.length, 0);
  const copy = repository.get('A');
  copy.terms.length = 0;
  assert.equal(repository.get('A').terms.length, 2);
  fail = true;
  await assert.rejects(repository.call('A', 'clear'), /disk unavailable/);
  assert.equal(repository.get('A').terms.length, 2);
});
