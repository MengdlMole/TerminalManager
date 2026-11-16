import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import './style.css';
import { defaultGroup, directoriesFor, emptyWorkspace, matches, normalizeWorkspace, removeGroup, resolveTerminal, tagsFrom, updateGroup, type TerminalDefinition } from './model';
import { icon } from './icons';
import { combobox } from './combobox';
import { resizableSidebar } from './sidebar';

type Status = 'starting' | 'running' | 'exited' | 'error';
interface Runtime {
  runId: string;
  terminal: Terminal; fit: FitAddon; search: SearchAddon; host: HTMLDivElement;
  status: Status; pid?: number; unread: boolean; bell: boolean; exitCode?: number;
  channel: Channel<ArrayBuffer | number[]>; ackBytes: number; ackTimer?: ReturnType<typeof setTimeout>;
  input: string[]; writing: boolean; disposed: boolean;
}
interface Defaults { shell: string; cwd: string; configDir: string }
interface ExitEvent { id: string; code: number; error?: string }
interface ControlRequest { requestId: string; action: string; args: Record<string, unknown> }

const mac = /Mac/.test(navigator.platform);
const shortcut = mac ? '⌘' : 'Ctrl';
const listShortcut = mac ? '⌘ K' : 'Ctrl ⇧ K';
let defaults: Defaults = { shell: '', cwd: '~', configDir: '' };
let workspace = emptyWorkspace();
const runtimes = new Map<string, Runtime>();
let query = '';
let canSave = true;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saveChain = Promise.resolve();
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let fitFrame = 0;
const root = document.querySelector<HTMLDivElement>('#app')!;

root.innerHTML = `
  <aside class="sidebar">
    <div class="brand"><span class="brand-icon">${icon('terminal')}</span><span>Terminal Manager<small>LOCAL WORKSPACE</small></span></div>
    <button class="new-button" id="new-terminal">${icon('plus')}<span>新建终端</span><kbd>${shortcut} ⇧ T</kbd></button>
    <label class="sidebar-search">${icon('search')}<input id="filter" placeholder="搜索名称、分组、标签…" aria-label="搜索终端"/><kbd>${listShortcut}</kbd></label>
    <div class="section-label"><span>工作空间</span><button class="icon-button" id="new-group" title="新建分组" aria-label="新建分组">${icon('plus')}</button></div>
    <nav id="terminal-list" aria-label="终端列表"></nav>
    <div class="sidebar-footer"><span class="local-dot"></span><span>仅在本机运行</span><button class="icon-button" id="settings" title="设置与快捷键" aria-label="设置与快捷键">${icon('settings')}</button></div>
    <div id="sidebar-resizer" role="separator" tabindex="0" aria-label="调整侧栏宽度" aria-orientation="vertical" aria-controls="terminal-list" title="拖动调整侧栏宽度；双击恢复默认。支持左右方向键，Enter 恢复默认。"></div>
  </aside>
  <main class="main">
    <header id="terminal-header"></header>
    <div class="find-bar" id="find-bar" hidden><input id="find-input" placeholder="在当前终端中查找" aria-label="查找终端输出"/><span id="find-result"></span><button class="text-button" id="find-prev">上一个</button><button class="text-button" id="find-next">下一个</button><button class="icon-button" id="find-close" aria-label="关闭查找">${icon('close')}</button></div>
    <section id="terminal-area" aria-label="终端"><div id="empty-state"></div></section>
    <footer class="status-bar"><span id="status-text"></span><span id="size-text"></span><span class="status-hint">切换终端，任务继续运行</span></footer>
  </main>
  <div id="toast" role="status" hidden></div>
  <dialog id="modal"><form id="modal-form"></form></dialog>
`;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const list = $('terminal-list');
const area = $('terminal-area');
const empty = $('empty-state');
const modal = $<HTMLDialogElement>('modal');
const form = $<HTMLFormElement>('modal-form');
const sidebarLayout = resizableSidebar(root, $('sidebar-resizer'), {
  read: () => workspace.sidebarWidth,
  commit: width => { workspace.sidebarWidth = width; persist(); },
});

function textElement(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
function button(label: string, glyph: string, callback: () => void): HTMLButtonElement {
  const node = document.createElement('button'); node.className = 'icon-button'; node.title = label; node.setAttribute('aria-label', label);
  node.innerHTML = icon(glyph); node.onclick = callback; return node;
}
function notify(message: unknown): void {
  const toast = $('toast'); toast.textContent = String(message); toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { toast.hidden = true; }, 6000);
}
function persist(): void {
  if (!canSave || !isTauri()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void flushSave(); }, 250);
}
function flushSave(): Promise<void> {
  clearTimeout(saveTimer);
  if (!canSave || !isTauri()) return Promise.resolve();
  const snapshot = structuredClone(workspace);
  saveChain = saveChain.then(() => invoke<void>('save_workspace', { workspace: snapshot })).catch(notify);
  return saveChain;
}
function statusLabel(runtime?: Runtime): string {
  return !runtime ? '未启动' : ({ starting: '启动中', running: '运行中', exited: `已退出 · ${runtime.exitCode ?? 0}`, error: '启动失败' })[runtime.status];
}
function activeDefinition(): TerminalDefinition | undefined { return workspace.terminals.find(t => t.id === workspace.activeId); }

function renderList(): void {
  const fragment = document.createDocumentFragment();
  const groups = workspace.terminals.some(t => !t.group) ? ['', ...workspace.groups] : workspace.groups;
  for (const group of groups) {
    const terminals = workspace.terminals.filter(t => t.group === group && matches(t, query));
    if (query && !terminals.length) continue;
    const section = document.createElement('section'); section.className = 'group';
    const heading = document.createElement('div'); heading.className = 'group-heading';
    const toggle = document.createElement('button'); toggle.className = 'group-toggle';
    const collapsed = workspace.collapsed.includes(group) && !query;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.innerHTML = `<span class="chevron ${collapsed ? '' : 'expanded'}">${icon('chevron')}</span>${icon('folder')}`;
    toggle.append(textElement('span', 'group-name', group || '未分组'), textElement('span', 'group-count', String(terminals.length)));
    toggle.onclick = () => { workspace.collapsed = collapsed ? workspace.collapsed.filter(g => g !== group) : [...workspace.collapsed, group]; persist(); renderList(); };
    heading.append(toggle, button('在此分组新建终端', 'plus', () => terminalDialog(undefined, group)));
    if (group) heading.append(button(`编辑分组：${group}`, 'edit', () => groupDialog(group)));
    section.append(heading);
    if (!collapsed) {
      for (const definition of terminals) {
        const runtime = runtimes.get(definition.id);
        const row = document.createElement('div'); row.className = `terminal-row ${definition.id === workspace.activeId ? 'selected' : ''}`;
        const select = document.createElement('button'); select.className = 'terminal-select';
        select.title = `${definition.name}\n${definition.cwd}\n${statusLabel(runtime)}`;
        const glyph = document.createElement('span'); glyph.className = `terminal-glyph ${runtime?.status ?? 'stopped'}`; glyph.innerHTML = icon('terminal');
        const content = document.createElement('span'); content.className = 'row-content';
        content.append(textElement('span', 'terminal-name', definition.name));
        if (definition.tags.length) content.append(textElement('span', 'row-tags', definition.tags.map(t => `#${t}`).join('  ')));
        const dot = document.createElement('span'); dot.className = `state-dot ${runtime?.status === 'running' ? 'running' : ''} ${runtime?.unread ? 'unread' : ''} ${runtime?.bell ? 'bell' : ''}`;
        dot.title = runtime?.bell ? '终端响铃' : runtime?.unread ? '有新输出' : statusLabel(runtime);
        select.append(glyph, content, dot); select.onclick = () => selectTerminal(definition.id);
        row.append(select, button('编辑终端', 'edit', () => terminalDialog(definition)), button('关闭终端', 'close', () => void confirmClose(definition)));
        section.append(row);
      }
      if (!terminals.length) {
        const count = directoriesFor(workspace, group).length;
        section.append(textElement('div', 'group-empty', `还没有终端${count ? ` · ${count} 个工作目录` : ''}`));
      }
    }
    fragment.append(section);
  }
  if (!fragment.childNodes.length) fragment.append(textElement('p', 'no-results', '没有匹配的终端'));
  list.replaceChildren(fragment);
  renderStatus();
}

function renderHeader(): void {
  const definition = activeDefinition();
  const header = $('terminal-header'); header.replaceChildren();
  if (!definition) { header.append(textElement('span', 'header-breadcrumb', '工作空间')); return; }
  const names = document.createElement('div'); names.className = 'header-names';
  const line = document.createElement('div'); line.className = 'header-line';
  line.append(textElement('span', 'header-group', definition.group || '未分组'), textElement('span', 'header-slash', '/'), textElement('strong', '', definition.name));
  for (const tag of definition.tags) line.append(textElement('span', 'tag', tag));
  names.append(line, textElement('div', 'header-path', definition.cwd));
  const actions = document.createElement('div'); actions.className = 'header-actions';
  actions.append(button('查找输出', 'search', showFind), button('编辑名称、分组和标签', 'edit', () => terminalDialog(definition)),
    button('复制配置新建终端', 'copy', () => terminalDialog(undefined, definition.group, definition)),
    button('关闭终端', 'close', () => void confirmClose(definition)));
  const runtime = runtimes.get(definition.id);
  if (runtime && ['exited', 'error'].includes(runtime.status)) actions.prepend(button('重新启动 Shell', 'play', () => void startTerminal(definition).catch(notify)));
  header.append(names, actions);
}

function renderStatus(): void {
  const runtime = workspace.activeId ? runtimes.get(workspace.activeId) : undefined;
  const count = [...runtimes.values()].filter(r => r.status === 'running' || r.status === 'starting').length;
  $('status-text').textContent = `${count} 个运行中${workspace.activeId ? `  ·  ${statusLabel(runtime)}` : ''}${runtime?.pid ? `  ·  PID ${runtime.pid}` : ''}`;
  $('size-text').textContent = runtime ? `${runtime.terminal.cols} × ${runtime.terminal.rows}` : '';
}

function selectTerminal(id: string): void {
  workspace.activeId = id;
  const definition = activeDefinition(); if (!definition) return;
  workspace.collapsed = workspace.collapsed.filter(g => g !== definition.group);
  for (const [key, runtime] of runtimes) {
    runtime.host.hidden = key !== id;
    if (key === id) { runtime.unread = false; runtime.bell = false; }
  }
  renderList(); renderHeader(); renderEmpty(); persist(); scheduleFit();
  runtimes.get(id)?.terminal.focus();
}

function renderEmpty(): void {
  const definition = activeDefinition();
  const runtime = definition ? runtimes.get(definition.id) : undefined;
  empty.hidden = !!runtime;
  if (runtime) return;
  empty.innerHTML = `<div class="empty-inner"><span class="empty-mark">${icon('terminal')}</span><span class="eyebrow">YOUR TERMINALS, TOGETHER.</span><h1></h1><p></p><button class="primary empty-action"></button><div class="empty-features"><span>独立 Shell</span><span>后台持续运行</span><span>本地存储</span></div></div>`;
  empty.querySelector('h1')!.textContent = definition ? definition.name : '给每个任务，一个终端';
  empty.querySelector('p')!.textContent = definition ? '配置已保留。启动一个新的 Shell，继续你的工作。' : '把终端放进分组，随时切换。\n你在这里输入，其他任务照常运行。';
  const action = empty.querySelector<HTMLButtonElement>('button')!;
  action.innerHTML = `${icon(definition ? 'play' : 'plus')} ${definition ? '启动终端' : '新建第一个终端'}`;
  action.onclick = () => definition ? void startTerminal(definition).catch(notify) : terminalDialog();
}

function scheduleFit(): void {
  if (fitFrame) cancelAnimationFrame(fitFrame);
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0;
    const runtime = workspace.activeId ? runtimes.get(workspace.activeId) : undefined;
    if (!runtime || runtime.disposed || runtime.host.hidden) return;
    runtime.fit.fit(); renderStatus();
  });
}

async function drainInput(id: string, runtime: Runtime): Promise<void> {
  if (runtime.writing || runtime.status !== 'running') return;
  runtime.writing = true;
  try {
    while (runtime.input.length && !runtime.disposed && runtime.status === 'running') {
      const data = runtime.input.shift()!;
      await invoke('write_terminal', { id: runtime.runId, data });
    }
  } catch (error) { runtime.input = []; notify(error); }
  finally { runtime.writing = false; }
}

function enqueueInput(id: string, runtime: Runtime, data: string): void {
  // Split large pastes, preserving order (including bracketed-paste delimiters).
  for (let i = 0; i < data.length;) {
    let end = Math.min(i + 16384, data.length);
    if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1])) end--;
    runtime.input.push(data.slice(i, end)); i = end;
  }
  void drainInput(id, runtime);
}

async function startTerminal(definition: TerminalDefinition): Promise<void> {
  if (!isTauri()) { notify('请通过 npm run desktop 启动桌面应用，浏览器预览不能创建本机终端。'); return; }
  const old = runtimes.get(definition.id);
  if (old && (old.status === 'running' || old.status === 'starting')) { selectTerminal(definition.id); return; }
  if (old) { await invoke('close_terminal', { id: old.runId }); disposeRuntime(definition.id); }
  const host = document.createElement('div'); host.className = 'terminal-host'; host.hidden = definition.id !== workspace.activeId; area.append(host);
  const terminal = new Terminal({
    cursorBlink: false, fontSize: workspace.fontSize,
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
    scrollback: workspace.scrollback, allowProposedApi: false,
    theme: { background: '#151719', foreground: '#dedfdf', cursor: '#a6dab5', selectionBackground: '#42554a',
      black: '#303538', red: '#e58d8d', green: '#a6dab5', yellow: '#dfc58d', blue: '#92b9e5', magenta: '#c6a2de', cyan: '#8ccfd0', white: '#dedfdf', brightBlack: '#7e888e' },
  });
  const fit = new FitAddon(); const search = new SearchAddon(); terminal.loadAddon(fit); terminal.loadAddon(search); terminal.open(host);
  const channel = new Channel<ArrayBuffer | number[]>();
  const runtime: Runtime = { runId: crypto.randomUUID(), terminal, fit, search, host, channel, status: 'starting', unread: false, bell: false, ackBytes: 0, input: [], writing: false, disposed: false };
  runtimes.set(definition.id, runtime);
  const acknowledge = () => {
    clearTimeout(runtime.ackTimer); runtime.ackTimer = undefined;
    const bytes = runtime.ackBytes; runtime.ackBytes = 0;
    if (bytes && !runtime.disposed) void invoke('ack_output', { id: runtime.runId, bytes }).catch(notify);
  };
  channel.onmessage = data => {
    if (runtime.disposed) return;
    const bytes = new Uint8Array(data);
    terminal.write(bytes, () => {
      runtime.ackBytes += bytes.byteLength;
      if (runtime.ackBytes >= 65536) acknowledge();
      else if (!runtime.ackTimer) runtime.ackTimer = setTimeout(acknowledge, 16);
    });
    if (workspace.activeId !== definition.id && !runtime.unread) { runtime.unread = true; renderList(); }
  };
  terminal.onData(data => enqueueInput(definition.id, runtime, data));
  terminal.onResize(({ cols, rows }) => {
    if (runtime.status === 'running') void invoke('resize_terminal', { id: runtime.runId, cols, rows }).catch(notify);
  });
  terminal.onBell(() => { runtime.bell = true; renderList(); });
  terminal.attachCustomKeyEventHandler(event => {
    if (event.type !== 'keydown' || event.isComposing || event.keyCode === 229) return true;
    if (event.shiftKey && event.key === 'Enter' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); enqueueInput(definition.id, runtime, '\n'); return false;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyC') {
      event.preventDefault(); void navigator.clipboard.writeText(terminal.getSelection()).catch(notify); return false;
    }
    if (event.ctrlKey && event.shiftKey && !event.altKey && event.code === 'KeyV') {
      event.preventDefault(); void navigator.clipboard.readText().then(text => terminal.paste(text)).catch(notify); return false;
    }
    return !isManagerShortcut(event);
  });
  renderEmpty(); renderList();
  if (!host.hidden) fit.fit();
  try {
    const result = await invoke<{ pid?: number; shell: string; cwd: string }>('create_terminal', {
      options: { ...definition, id: runtime.runId, logicalId: definition.id, cols: terminal.cols, rows: terminal.rows }, output: channel,
    });
    if (runtime.disposed) { await invoke('close_terminal', { id: runtime.runId }); return; }
    runtime.pid = result.pid;
    if (runtime.status === 'starting') runtime.status = 'running';
    void drainInput(definition.id, runtime);
    definition.cwd = result.cwd; definition.shell = result.shell;
    if (runtime.status === 'running') await invoke('resize_terminal', { id: runtime.runId, cols: terminal.cols, rows: terminal.rows });
    persist(); renderHeader();
  } catch (error) { if (!runtime.disposed) { runtime.status = 'error'; terminal.writeln(`\r\n\x1b[31m启动失败：${String(error)}\x1b[0m`); } throw error; }
  finally { renderList(); renderHeader(); if (!runtime.disposed && workspace.activeId === definition.id) terminal.focus(); }
}

function disposeRuntime(id: string): void {
  const runtime = runtimes.get(id); if (!runtime) return;
  runtime.disposed = true; runtime.channel.onmessage = () => {}; clearTimeout(runtime.ackTimer); runtime.terminal.dispose(); runtime.host.remove(); runtimes.delete(id);
}

async function removeTerminal(definition: TerminalDefinition): Promise<void> {
  const runtime = runtimes.get(definition.id);
  if (isTauri() && runtime) await invoke('close_terminal', { id: runtime.runId });
  const index = workspace.terminals.indexOf(definition);
  disposeRuntime(definition.id); workspace.terminals = workspace.terminals.filter(t => t.id !== definition.id);
  if (workspace.activeId === definition.id) workspace.activeId = workspace.terminals[Math.min(index, workspace.terminals.length - 1)]?.id ?? null;
  if (workspace.activeId) selectTerminal(workspace.activeId);
  else { renderList(); renderHeader(); renderEmpty(); persist(); }
}

async function confirmClose(definition: TerminalDefinition): Promise<void> {
  const runtime = runtimes.get(definition.id);
  if (!runtime || ['exited', 'error'].includes(runtime.status)) { await removeTerminal(definition).catch(notify); return; }
  confirmDialog('关闭这个终端？', `“${definition.name}”中的 Shell 和正在运行的任务将被终止。`, '关闭终端', () => removeTerminal(definition));
}

function openModal(content: string, submit: (data: FormData) => Promise<void> | void): void {
  if (modal.open) modal.close();
  form.innerHTML = content;
  form.querySelectorAll('[data-cancel]').forEach(node => node.addEventListener('click', () => modal.close()));
  form.onsubmit = async event => {
    event.preventDefault(); const action = form.querySelector<HTMLButtonElement>('[type=submit]')!; action.disabled = true;
    try { await submit(new FormData(form)); modal.close(); }
    catch (error) { const errorNode = form.querySelector<HTMLElement>('.form-error'); if (errorNode) errorNode.textContent = String(error); else notify(error); }
    finally { action.disabled = false; }
  };
  modal.showModal();
}

function confirmDialog(title: string, message: string, label: string, action: () => Promise<void>): void {
  openModal(`<div class="modal-heading"><h2></h2></div><p class="confirm-message"></p><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="danger"></button></div>`, action);
  form.querySelector('h2')!.textContent = title; form.querySelector('.confirm-message')!.textContent = message;
  form.querySelector('[type=submit]')!.textContent = label;
}

function terminalDialog(definition?: TerminalDefinition, group?: string, copy?: TerminalDefinition): void {
  const source = definition ?? copy;
  openModal(`
    <div class="modal-heading"><span class="modal-icon">${icon('terminal')}</span><h2>${definition ? '编辑终端' : '新建终端'}</h2><button type="button" class="icon-button" data-cancel aria-label="取消">${icon('close')}</button></div>
    <label>名称<input name="name" required maxlength="120" autocomplete="off" placeholder="例如：后端开发"/></label>
    <div class="form-columns"><div class="form-field"><label for="terminal-group">分组<span class="optional">可清空</span></label><div id="group-picker"></div><span class="field-hint">留空则不分组，也可输入新分组</span></div><label>标签<span class="optional">逗号分隔</span><input name="tags" placeholder="工作, 调试"/></label></div>
    <div class="form-field"><label for="terminal-cwd">工作目录</label><div id="cwd-picker" class="path-picker"></div><span class="field-hint" id="cwd-hint"></span></div>
    <label>Shell<span class="optional">可执行文件路径，不包含参数</span><input name="shell" placeholder="使用系统默认 Shell" autocomplete="off" spellcheck="false"/></label>
    <p class="form-hint">使用真实交互式 Shell，加载你已有的配置、提示符和补全。${definition && runtimes.has(definition.id) ? '目录和 Shell 修改将在下次启动生效。' : ''}</p>
    <div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="primary">${definition ? '保存修改' : '创建并启动'}</button></div>`,
    async data => {
      const values = { name: String(data.get('name')).trim(), group: String(data.get('group')).trim(),
        tags: tagsFrom(String(data.get('tags'))), cwd: String(data.get('cwd')).trim(), shell: String(data.get('shell')).trim() };
      if (!values.name) throw new Error('请输入终端名称');
      if (values.group && !workspace.groups.includes(values.group)) workspace.groups.push(values.group);
      if (definition) { Object.assign(definition, values); renderList(); renderHeader(); persist(); }
      else {
        if (workspace.terminals.length >= 128) throw new Error('最多保留 128 个终端');
        const created = { id: crypto.randomUUID(), ...values };
        workspace.terminals.push(created); selectTerminal(created.id); persist();
        // Preserve the failed terminal for inspection; do not create duplicates on retry.
        modal.close(); await startTerminal(created).catch(notify);
      }
    });
  const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
  field('name').value = definition?.name ?? (copy ? `${copy.name} 副本` : `Terminal ${workspace.terminals.length + 1}`);
  let selectedGroup = group ?? source?.group ?? activeDefinition()?.group ?? workspace.groups[0] ?? '';
  const cwdPicker = combobox($('cwd-picker'), {
    id: 'terminal-cwd', name: 'cwd', label: '工作目录', required: true,
    value: source?.cwd ?? directoriesFor(workspace, selectedGroup)[0] ?? defaults.cwd,
    placeholder: '选择已保存的目录，或输入路径',
    choices: () => directoriesFor(workspace, selectedGroup).map(path => ({ value: path,
      label: path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path, description: path })),
    emptyMessage: '没有匹配的已保存目录，可直接输入路径',
  });
  const updateDirectoryChoices = () => {
    const count = directoriesFor(workspace, selectedGroup).length;
    $('cwd-hint').textContent = count ? `此分组有 ${count} 个工作目录，可下拉选择或手动输入` : '可手动输入路径；在「编辑分组」中添加常用工作目录';
    cwdPicker.refresh();
  };
  combobox($('group-picker'), {
    id: 'terminal-group', name: 'group', label: '分组', value: selectedGroup, maxLength: 80, clearable: true,
    placeholder: '未分组', emptyMessage: '没有匹配的分组，将使用输入的名称创建',
    choices: () => [{ value: '', label: '未分组', description: '不加入任何分组' }, ...workspace.groups.map(name => ({ value: name,
      description: `${directoriesFor(workspace, name).length} 个工作目录` }))],
    onChange: value => { selectedGroup = value.trim(); updateDirectoryChoices(); },
  });
  updateDirectoryChoices();
  field('tags').value = source?.tags.join(', ') ?? '';
  field('shell').value = source?.shell ?? defaults.shell;
  field('name').focus(); field('name').select();
}

function groupDialog(existing?: string): void {
  openModal(`<div class="modal-heading"><span class="modal-icon">${icon('folder')}</span><h2>${existing ? '编辑分组' : '新建分组'}</h2><button type="button" class="icon-button" data-cancel aria-label="取消">${icon('close')}</button></div>
    <label>分组名称<input name="name" required maxlength="80" autocomplete="off" ${existing === defaultGroup ? 'readonly' : ''}/></label>
    <fieldset class="directory-editor"><legend>工作目录<span class="optional-inline">最多 32 个</span></legend>
      <p class="form-hint">新建终端时可直接选择这些目录，也可以输入其他路径。</p><div id="directory-rows"></div>
      <button type="button" class="text-button add-directory" id="add-directory">${icon('plus')} 添加工作目录</button>
    </fieldset><div class="form-error" role="alert"></div><div class="modal-actions">${existing ? '<button type="button" class="danger delete-group" id="delete-group">删除分组</button>' : ''}<button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="primary">保存分组</button></div>`, data => {
    updateGroup(workspace, String(data.get('name')), data.getAll('directory').map(String), existing);
    renderList(); renderHeader(); persist();
  });
  const rows = $('directory-rows');
  const updateRows = () => {
    rows.querySelectorAll('input').forEach((input, index) => input.setAttribute('aria-label', `工作目录 ${index + 1}`));
    $<HTMLButtonElement>('add-directory').disabled = rows.children.length >= 32;
  };
  const addDirectory = (path = '') => {
    if (rows.children.length >= 32) return;
    const row = document.createElement('div'); row.className = 'directory-row';
    const input = document.createElement('input'); input.name = 'directory'; input.value = path; input.placeholder = '输入工作目录路径'; input.autocomplete = 'off'; input.spellcheck = false;
    const remove = button('移除工作目录', 'close', () => { row.remove(); updateRows(); }); remove.type = 'button';
    row.append(input, remove); rows.append(row); updateRows(); return input;
  };
  const paths = existing ? directoriesFor(workspace, existing) : [];
  for (const path of paths.length ? paths : ['']) addDirectory(path);
  $('add-directory').onclick = () => addDirectory()?.focus();
  if (existing) $('delete-group').onclick = () => {
    confirmDialog('删除分组？', `删除“${existing}”及其常用目录记录，其中的终端会移到「未分组」并继续运行。`, '删除分组', async () => {
      removeGroup(workspace, existing);
      renderList(); renderHeader(); renderEmpty(); await flushSave();
    });
  };
  const input = form.elements.namedItem('name') as HTMLInputElement; input.value = existing ?? ''; input.focus();
}

function settingsDialog(): void {
  openModal(`<div class="modal-heading"><h2>保持简单，保持轻快。</h2></div>
    <div class="form-columns"><label>字号<input name="fontSize" type="number" min="10" max="24"/></label><label>每终端历史行数<input name="scrollback" type="number" min="500" max="10000" step="100"/></label></div>
    <p class="form-hint">后台终端继续运行和解析输出；仅当前终端显示。历史行数越少，占用越低。应用退出会结束终端，下次启动保留配置。</p>
    <div class="shortcut-list"><span>新建终端<kbd>${shortcut} Shift T</kbd></span><span>搜索列表<kbd>${listShortcut}</kbd></span><span>查找输出<kbd>${mac ? '⌘ F' : 'Ctrl Shift F'}</kbd></span><span>切换终端<kbd>Ctrl Tab / Ctrl Shift Tab</kbd></span><span>复制 / 粘贴<kbd>${mac ? '⌘ C / V' : 'Ctrl Shift C / V'}</kbd></span><span>多行输入<kbd>Shift Enter</kbd></span></div>
    <label>配置目录<input id="config-path" readonly/></label><div class="form-error" role="alert"></div><div class="modal-actions"><button type="button" class="secondary" data-cancel>取消</button><button type="submit" class="primary">保存设置</button></div>`, data => {
    workspace.fontSize = Number(data.get('fontSize')); workspace.scrollback = Number(data.get('scrollback'));
    for (const runtime of runtimes.values()) { runtime.terminal.options.fontSize = workspace.fontSize; runtime.terminal.options.scrollback = workspace.scrollback; }
    scheduleFit(); persist();
  });
  (form.elements.namedItem('fontSize') as HTMLInputElement).value = String(workspace.fontSize);
  (form.elements.namedItem('scrollback') as HTMLInputElement).value = String(workspace.scrollback);
  $<HTMLInputElement>('config-path').value = defaults.configDir;
}

function showFind(): void {
  if (!workspace.activeId || !runtimes.has(workspace.activeId)) return;
  $('find-bar').hidden = false; $<HTMLInputElement>('find-input').focus(); scheduleFit();
}
function hideFind(): void { $('find-bar').hidden = true; scheduleFit(); if (workspace.activeId) runtimes.get(workspace.activeId)?.terminal.focus(); }
function find(previous = false): void {
  const runtime = workspace.activeId ? runtimes.get(workspace.activeId) : undefined;
  const query = $<HTMLInputElement>('find-input').value;
  const found = previous ? runtime?.search.findPrevious(query) : runtime?.search.findNext(query);
  $('find-result').textContent = !query ? '' : found ? '' : '未找到';
}
function isManagerShortcut(event: KeyboardEvent): boolean {
  const modifier = mac ? event.metaKey : event.ctrlKey;
  return (modifier && !event.altKey && ((event.shiftKey && event.code === 'KeyT') || (event.code === 'KeyK' && (mac || event.shiftKey)) || (event.code === 'KeyF' && (mac || event.shiftKey))))
    || (event.ctrlKey && event.key === 'Tab');
}

document.addEventListener('keydown', event => {
  if (event.isComposing || modal.open) return;
  if (event.key === 'Escape' && !$('find-bar').hidden) { event.preventDefault(); hideFind(); return; }
  if (!isManagerShortcut(event)) return;
  event.preventDefault();
  if (event.code === 'KeyT') terminalDialog();
  else if (event.code === 'KeyK') { $<HTMLInputElement>('filter').focus(); $<HTMLInputElement>('filter').select(); }
  else if (event.code === 'KeyF') showFind();
  else if (event.key === 'Tab' && workspace.terminals.length) {
    const index = workspace.terminals.findIndex(t => t.id === workspace.activeId);
    selectTerminal(workspace.terminals[(index + (event.shiftKey ? -1 : 1) + workspace.terminals.length) % workspace.terminals.length].id);
  }
}, true);

$('new-terminal').onclick = () => terminalDialog();
$('new-group').onclick = () => groupDialog();
$('settings').onclick = settingsDialog;
$<HTMLInputElement>('filter').oninput = event => { query = (event.target as HTMLInputElement).value; renderList(); };
$<HTMLInputElement>('filter').onkeydown = event => { if (event.key === 'Escape') { query = ''; $<HTMLInputElement>('filter').value = ''; renderList(); } };
$('find-close').onclick = hideFind; $('find-prev').onclick = () => find(true); $('find-next').onclick = () => find();
$<HTMLInputElement>('find-input').oninput = () => find();
$<HTMLInputElement>('find-input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); find(event.shiftKey); } };
new ResizeObserver(scheduleFit).observe(area);

async function control(request: ControlRequest): Promise<unknown> {
  const args = request.args;
  if (request.action === 'list') return workspace.terminals.map(t => ({ ...t, status: runtimes.get(t.id)?.status ?? 'stopped', pid: runtimes.get(t.id)?.pid }));
  if (request.action === 'new') {
    if (workspace.terminals.length >= 128) throw new Error('最多保留 128 个终端');
    const terminal: TerminalDefinition = { id: crypto.randomUUID(), name: String(args.name || 'Terminal').slice(0, 120), group: String(args.group ?? defaultGroup).trim().slice(0, 80),
      tags: tagsFrom(Array.isArray(args.tags) ? args.tags.map(String) : []), cwd: String(args.cwd || defaults.cwd), shell: String(args.shell || defaults.shell) };
    if (terminal.group && !workspace.groups.includes(terminal.group)) workspace.groups.push(terminal.group);
    workspace.terminals.push(terminal); selectTerminal(terminal.id); await startTerminal(terminal); await flushSave(); return terminal;
  }
  const definition = resolveTerminal(workspace.terminals, String(args.id));
  switch (request.action) {
    case 'start': await startTerminal(definition); break;
    case 'read': {
      const runtime = runtimes.get(definition.id); if (!runtime) throw new Error('终端没有启动');
      const buffer = runtime.terminal.buffer.active;
      const end = buffer.baseY + buffer.cursorY + 1;
      const lines = Math.min(1000, Math.max(1, Number(args.lines) || 100));
      const output: string[] = [];
      for (let index = Math.max(0, end - lines); index < end; index++) output.push(buffer.getLine(index)?.translateToString(true) ?? '');
      return { id: definition.id, text: output.join('\n') };
    }
    case 'focus': selectTerminal(definition.id); await invoke('focus_window'); break;
    case 'rename': { const name = String(args.name || '').trim(); if (!name) throw new Error('名称不能为空'); definition.name = name.slice(0, 120); break; }
    case 'tag': definition.tags = tagsFrom(Array.isArray(args.tags) ? args.tags.map(String) : []); break;
    case 'group': definition.group = String(args.name ?? '').trim().slice(0, 80);
      if (definition.group && !workspace.groups.includes(definition.group)) workspace.groups.push(definition.group); break;
    case 'send': {
      if (runtimes.get(definition.id)?.status !== 'running') throw new Error('终端没有运行');
      await invoke('write_terminal', { id: runtimes.get(definition.id)!.runId, data: String(args.text ?? '') + (args.enter ? '\r' : '') }); break;
    }
    case 'close': await removeTerminal(definition); break;
    default: throw new Error('未知操作');
  }
  renderList(); renderHeader(); await flushSave(); return { ok: true, id: definition.id };
}

async function initialize(): Promise<void> {
  if (isTauri()) {
    defaults = await invoke<Defaults>('defaults');
    try { const saved = await invoke<unknown>('load_workspace'); if (saved) workspace = normalizeWorkspace(saved); }
    catch (error) { canSave = false; notify(`${String(error)}。已禁用自动保存，避免覆盖原配置。`); }
    await listen<ExitEvent>('terminal-exit', ({ payload }) => {
      const found = [...runtimes.entries()].find(([, runtime]) => runtime.runId === payload.id);
      if (!found) return;
      const [, runtime] = found;
      runtime.status = 'exited'; runtime.exitCode = payload.code;
      runtime.terminal.write(`\r\n\x1b[90m[Shell 已退出 · ${payload.code}]\x1b[0m\r\n`);
      if (payload.error) notify(payload.error);
      renderList(); renderHeader();
    });
    await listen('confirm-quit', () => {
      if (modal.open) return;
      confirmDialog('退出 Terminal Manager？', '所有运行中的终端将被终止。名称、分组和标签会保留，运行中的任务不会在下次启动恢复。', '结束终端并退出', async () => { await flushSave(); await invoke('quit_app'); });
    });
    await listen<ControlRequest>('control-request', async ({ payload }) => {
      let response: unknown;
      try { response = await control(payload); } catch (error) { response = { error: String(error) }; }
      await invoke('control_response', { requestId: payload.requestId, response });
    });
    await invoke('frontend_ready');
  }
  sidebarLayout.refresh(); renderList(); renderHeader(); renderEmpty();
  if (!isTauri()) notify('界面预览模式 · 运行 npm run desktop 使用真实终端');
}
void initialize().catch(notify);
