export interface TerminalDefinition {
  id: string;
  name: string;
  group: string;
  tags: string[];
  cwd: string;
  shell: string;
}

export interface Workspace {
  version: 1;
  terminals: TerminalDefinition[];
  groups: string[];
  groupDirectories: Record<string, string[]>;
  collapsed: string[];
  activeId: string | null;
  fontSize: number;
  scrollback: number;
}

export const defaultGroup = '默认分组';
export const emptyWorkspace = (): Workspace => ({
  version: 1, terminals: [], groups: [defaultGroup], groupDirectories: { [defaultGroup]: [] }, collapsed: [], activeId: null,
  fontSize: 14, scrollback: 3000,
});

export function tagsFrom(input: string | string[]): string[] {
  return [...new Set((Array.isArray(input) ? input : input.split(/[,，]/))
    .map(t => t.trim()).filter(Boolean))].slice(0, 12).map(t => t.slice(0, 40));
}

export function directoriesFrom(input: unknown): string[] {
  return Array.isArray(input) ? [...new Set(input.filter((p): p is string => typeof p === 'string')
    .map(p => p.trim()).filter(Boolean))].slice(0, 32) : [];
}

export function directoriesFor(workspace: Workspace, group: string): string[] {
  return Object.hasOwn(workspace.groupDirectories, group) ? workspace.groupDirectories[group] : [];
}

export function updateGroup(workspace: Workspace, name: string, directories: string[], existing?: string): void {
  name = name.trim();
  if (!name) throw new Error('请输入分组名称');
  if (existing === defaultGroup && name !== defaultGroup) throw new Error('默认分组不能重命名');
  if (name !== existing && workspace.groups.includes(name)) throw new Error('分组已存在');
  if (existing) {
    workspace.groups = workspace.groups.map(g => g === existing ? name : g);
    workspace.terminals.filter(t => t.group === existing).forEach(t => { t.group = name; });
    workspace.collapsed = workspace.collapsed.map(g => g === existing ? name : g);
    delete workspace.groupDirectories[existing];
  } else workspace.groups.push(name);
  workspace.groupDirectories = { ...workspace.groupDirectories, [name]: directoriesFrom(directories) };
}

export function removeGroup(workspace: Workspace, name: string): void {
  if (!workspace.groups.includes(name)) throw new Error('分组不存在');
  workspace.groups = workspace.groups.filter(group => group !== name);
  workspace.collapsed = workspace.collapsed.filter(group => group !== name);
  let moved = false;
  for (const terminal of workspace.terminals) {
    if (terminal.group === name) { terminal.group = ''; moved = true; }
  }
  if (moved) workspace.collapsed = workspace.collapsed.filter(group => group !== '');
  delete workspace.groupDirectories[name];
}

export function normalizeWorkspace(input: unknown): Workspace {
  if (!input || typeof input !== 'object') throw new Error('配置格式无效');
  const value = input as Record<string, unknown>;
  if (value.version !== 1 || !Array.isArray(value.terminals)) throw new Error('不支持的配置版本');
  const workspace = emptyWorkspace();
  const ids = new Set<string>();
  workspace.terminals = value.terminals.slice(0, 128).map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw new Error('终端配置无效');
    const terminal = entry as Record<string, unknown>;
    if (typeof terminal.id !== 'string' || ids.has(terminal.id)) throw new Error('终端 ID 无效或重复');
    ids.add(terminal.id);
    for (const key of ['name', 'group', 'cwd', 'shell']) {
      if (typeof terminal[key] !== 'string') throw new Error(`终端字段无效：${key}`);
    }
    return { id: terminal.id, name: (terminal.name as string).slice(0, 120) || 'Terminal',
      group: (terminal.group as string).trim().slice(0, 80),
      cwd: terminal.cwd as string, shell: terminal.shell as string,
      tags: Array.isArray(terminal.tags) ? tagsFrom(terminal.tags.filter((t): t is string => typeof t === 'string')) : [] };
  });
  workspace.groups = [...new Set([
    ...(Array.isArray(value.groups) ? value.groups.filter((g): g is string => typeof g === 'string' && !!g.trim()).map(g => g.slice(0, 80)) : [defaultGroup]),
    ...workspace.terminals.map(t => t.group).filter(Boolean)])];
  const directories = value.groupDirectories && typeof value.groupDirectories === 'object'
    ? value.groupDirectories as Record<string, unknown> : {};
  workspace.groupDirectories = Object.fromEntries(workspace.groups.map(group => [group, directoriesFrom(directories[group])]));
  workspace.collapsed = Array.isArray(value.collapsed) ? value.collapsed.filter((g): g is string => typeof g === 'string'
    && (workspace.groups.includes(g) || (g === '' && workspace.terminals.some(t => !t.group)))) : [];
  workspace.activeId = typeof value.activeId === 'string' && ids.has(value.activeId) ? value.activeId : workspace.terminals[0]?.id ?? null;
  if (typeof value.fontSize === 'number') workspace.fontSize = Math.min(24, Math.max(10, value.fontSize));
  if (typeof value.scrollback === 'number') workspace.scrollback = Math.min(10000, Math.max(500, Math.round(value.scrollback)));
  return workspace;
}

export function matches(terminal: TerminalDefinition, query: string): boolean {
  const text = [terminal.name, terminal.group || '未分组', terminal.cwd, ...terminal.tags].join(' ').toLocaleLowerCase();
  return query.toLocaleLowerCase().trim().split(/\s+/).every(word => text.includes(word));
}

export function resolveTerminal(terminals: TerminalDefinition[], ref: string): TerminalDefinition {
  const exact = terminals.find(t => t.id === ref);
  if (exact) return exact;
  const found = terminals.filter(t => t.id.startsWith(ref) || t.name === ref);
  if (found.length !== 1) throw new Error(found.length ? '名称或 ID 前缀不唯一，请使用完整 ID' : '未找到终端');
  return found[0];
}
