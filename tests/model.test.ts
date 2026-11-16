import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constrainSidebarWidth, defaultGroup, defaultSidebarWidth, directoriesFor, emptyWorkspace, normalizeWorkspace, matches, removeGroup, resolveTerminal, tagsFrom, updateGroup } from '../src/model.ts';

const terminal = { id: 'abcdef-123', name: '后端开发', group: '工作', tags: ['urgent', 'API'], cwd: '/tmp/project', shell: '/bin/zsh' };

test('sidebar preference survives reload, validates saved values and adapts to smaller windows', () => {
  const workspace = normalizeWorkspace({ ...emptyWorkspace(), sidebarWidth: 480 });
  assert.equal(constrainSidebarWidth(workspace.sidebarWidth, 760), 400);
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.sidebarWidth, 480);
  assert.equal(constrainSidebarWidth(restored.sidebarWidth, 1200), 480);
  assert.equal(normalizeWorkspace({ version: 1, terminals: [] }).sidebarWidth, defaultSidebarWidth);
  for (const width of [null, 'wide', NaN, Infinity]) {
    assert.equal(normalizeWorkspace({ ...emptyWorkspace(), sidebarWidth: width }).sidebarWidth, defaultSidebarWidth);
  }
  assert.equal(normalizeWorkspace({ ...emptyWorkspace(), sidebarWidth: -100 }).sidebarWidth, 220);
  assert.equal(normalizeWorkspace({ ...emptyWorkspace(), sidebarWidth: 99999 }).sidebarWidth, 520);
});

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

test('older workspaces load without directory metadata and ungrouped terminals survive reload', () => {
  const legacy = { version: 1, terminals: [terminal], groups: ['工作'] };
  const workspace = normalizeWorkspace(legacy);
  assert.deepEqual(directoriesFor(workspace, '工作'), []);
  workspace.terminals.push({ ...terminal, id: 'ungrouped', group: '' });
  workspace.collapsed = [''];
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.terminals[1].group, '');
  assert.ok(!restored.groups.includes(''));
  assert.deepEqual(restored.groups, ['工作']);
  assert.ok(normalizeWorkspace({ version: 1, terminals: [] }).groups.includes(defaultGroup));
  assert.deepEqual(restored.collapsed, ['']);
  assert.ok(matches(restored.terminals[1], '未分组'));
});

test('group directory choices survive save, rename and reload alongside terminal membership', () => {
  const workspace = normalizeWorkspace({ ...emptyWorkspace(), terminals: [terminal], collapsed: ['工作'] });
  updateGroup(workspace, '开发', [' /tmp/api ', 'E:\\项目 目录\\web', '/tmp/api', ''], '工作');
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.terminals[0].group, '开发');
  assert.deepEqual(restored.collapsed, ['开发']);
  assert.deepEqual(directoriesFor(restored, '开发'), ['/tmp/api', 'E:\\项目 目录\\web']);
  assert.deepEqual(directoriesFor(restored, '工作'), []);
  assert.throws(() => updateGroup(restored, defaultGroup, [], '开发'), /已存在/);
  assert.deepEqual(directoriesFor(restored, '开发'), ['/tmp/api', 'E:\\项目 目录\\web']);
});

test('default group directories are editable and unknown directory metadata is discarded', () => {
  const workspace = emptyWorkspace();
  updateGroup(workspace, defaultGroup, ['/tmp/default'], defaultGroup);
  const restored = normalizeWorkspace({ ...workspace, groupDirectories: { ...workspace.groupDirectories, orphan: ['/tmp/stale'] } });
  assert.deepEqual(directoriesFor(restored, defaultGroup), ['/tmp/default']);
  assert.deepEqual(directoriesFor(restored, 'orphan'), []);
});

test('deleting a populated group preserves terminals and selection across reload', () => {
  const workspace = normalizeWorkspace({ ...emptyWorkspace(), terminals: [terminal], activeId: terminal.id, collapsed: ['工作', ''] });
  updateGroup(workspace, '工作', ['/tmp/project'], '工作');
  const original = workspace.terminals[0];
  removeGroup(workspace, '工作');
  assert.equal(workspace.terminals[0], original);
  assert.deepEqual(original, { ...terminal, group: '' });
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.equal(restored.activeId, terminal.id);
  assert.equal(restored.terminals[0].group, '');
  assert.ok(!restored.groups.includes('工作'));
  assert.ok(!Object.hasOwn(restored.groupDirectories, '工作'));
  assert.ok(!restored.collapsed.includes('工作'));
});

test('default and empty groups can be deleted without reappearing on reload', () => {
  const workspace = emptyWorkspace();
  workspace.terminals.push({ ...terminal, group: defaultGroup });
  updateGroup(workspace, '空分组', ['/tmp/empty']);
  removeGroup(workspace, defaultGroup);
  assert.deepEqual(workspace.groups, ['空分组']);
  assert.deepEqual(directoriesFor(workspace, '空分组'), ['/tmp/empty']);
  removeGroup(workspace, '空分组');
  const restored = normalizeWorkspace(JSON.parse(JSON.stringify(workspace)));
  assert.deepEqual(restored.groups, []);
  assert.equal(restored.terminals.length, 1);
  assert.equal(restored.terminals[0].group, '');
});
