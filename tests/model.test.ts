import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyWorkspace, normalizeWorkspace, matches, resolveTerminal, tagsFrom } from '../src/model.ts';

const terminal = { id: 'abcdef-123', name: '后端开发', group: '工作', tags: ['urgent', 'API'], cwd: '/tmp/project', shell: '/bin/zsh' };

test('search combines group, directory, tags and name with case-insensitive AND terms', () => {
  assert.equal(matches(terminal, '后端 api'), true);
  assert.equal(matches(terminal, '工作 /tmp'), true);
  assert.equal(matches(terminal, '后端 frontend'), false);
});

test('CLI references reject ambiguous prefixes and names', () => {
  const other = { ...terminal, id: 'abcdef-456' };
  assert.equal(resolveTerminal([terminal, other], terminal.id), terminal);
  assert.throws(() => resolveTerminal([terminal, other], 'abc'), /不唯一/);
  assert.throws(() => resolveTerminal([terminal, other], terminal.name), /不唯一/);
  assert.throws(() => resolveTerminal([terminal], 'missing'), /未找到/);
});

test('workspace reload restores metadata and constrains memory-related settings', () => {
  const workspace = normalizeWorkspace({ ...emptyWorkspace(), terminals: [terminal], scrollback: 999999, fontSize: -5, activeId: 'missing' });
  assert.equal(workspace.scrollback, 10000);
  assert.equal(workspace.fontSize, 10);
  assert.equal(workspace.activeId, terminal.id);
  assert.ok(workspace.groups.includes('工作'));
  assert.throws(() => normalizeWorkspace({ version: 99, terminals: [] }), /版本/);
  assert.throws(() => normalizeWorkspace({ version: 1, terminals: [terminal, terminal] }), /重复/);
});

test('tag normalization deduplicates and handles Chinese comma', () => {
  assert.deepEqual(tagsFrom('工作， API,工作, , urgent'), ['工作', 'API', 'urgent']);
});
