import { icon } from './icons';

export interface Choice { value: string; label?: string; description?: string }

// Editable, keyboard-accessible suggestions without a UI framework or global listeners.
export function combobox(host: HTMLElement, options: {
  id: string; name: string; label: string; value: string; placeholder?: string;
  required?: boolean; maxLength?: number; clearable?: boolean;
  choices: () => Choice[]; emptyMessage: string; onChange?: (value: string) => void;
}): { input: HTMLInputElement; refresh: () => void } {
  host.classList.add('combobox');
  const input = document.createElement('input');
  input.id = options.id; input.name = options.name; input.value = options.value;
  input.placeholder = options.placeholder ?? ''; input.autocomplete = 'off'; input.spellcheck = false;
  input.required = options.required ?? false;
  if (options.maxLength) input.maxLength = options.maxLength;
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false'); input.setAttribute('aria-controls', `${options.id}-options`);
  const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'combo-clear icon-button';
  clear.innerHTML = icon('close'); clear.setAttribute('aria-label', `清空${options.label}`); clear.title = `清空${options.label}`;
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'combo-toggle icon-button';
  toggle.innerHTML = icon('chevron'); toggle.setAttribute('aria-label', `选择${options.label}`); toggle.title = `选择${options.label}`;
  const list = document.createElement('div'); list.id = `${options.id}-options`; list.className = 'combo-options';
  list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', options.label); list.hidden = true;
  host.append(input, clear, toggle, list);
  let visible: Choice[] = []; let active = -1; let filtering = false;
  const updateClear = () => { clear.hidden = !options.clearable || !input.value; };
  const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); active = -1; };
  function highlight(): void {
    [...list.querySelectorAll<HTMLElement>('[role=option]')].forEach((node, index) => node.classList.toggle('active', index === active));
    if (active >= 0) {
      input.setAttribute('aria-activedescendant', `${options.id}-option-${active}`);
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function choose(choice: Choice): void {
    input.value = choice.value; updateClear(); options.onChange?.(input.value); close(); input.focus();
  }
  function show(filter = false): void {
    filtering = filter; active = -1; list.replaceChildren();
    const query = filter ? input.value.trim().toLocaleLowerCase() : '';
    visible = options.choices().filter(choice => !query || [choice.value, choice.label, choice.description].join(' ').toLocaleLowerCase().includes(query));
    for (const [index, choice] of visible.entries()) {
      const option = document.createElement('button'); option.type = 'button'; option.tabIndex = -1;
      option.id = `${options.id}-option-${index}`; option.className = 'combo-option'; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(choice.value === input.value));
      const text = document.createElement('span'); text.className = 'combo-option-text';
      const title = document.createElement('span'); title.textContent = choice.label ?? choice.value; text.append(title);
      if (choice.description) { const detail = document.createElement('small'); detail.textContent = choice.description; text.append(detail); }
      const check = document.createElement('span'); check.className = 'combo-check'; check.textContent = choice.value === input.value ? '✓' : '';
      option.append(text, check); option.title = choice.description ?? choice.value;
      option.onpointerdown = event => event.preventDefault(); option.onclick = () => choose(choice); list.append(option);
    }
    if (!visible.length) { const empty = document.createElement('div'); empty.className = 'combo-empty'; empty.textContent = options.emptyMessage; list.append(empty); }
    list.hidden = false; input.setAttribute('aria-expanded', 'true'); input.removeAttribute('aria-activedescendant');
    const boundary = host.closest('dialog')!.getBoundingClientRect(); const box = input.getBoundingClientRect();
    const below = boundary.bottom - box.bottom - 12; const above = box.top - boundary.top - 12;
    const upwards = below < 150 && above > below;
    list.classList.toggle('above', upwards); list.style.maxHeight = `${Math.max(70, Math.min(230, upwards ? above : below))}px`;
  }
  input.oninput = () => { updateClear(); options.onChange?.(input.value); show(true); };
  input.onfocus = () => show();
  input.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); if (list.hidden) show();
      if (visible.length) { active = event.key === 'ArrowDown' ? (active + 1) % visible.length : (active < 0 ? visible.length - 1 : (active - 1 + visible.length) % visible.length); highlight(); }
    } else if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault(); if (active >= 0) choose(visible[active]); else close();
    } else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
    else if (event.key === 'Tab') close();
  };
  host.addEventListener('focusout', event => { if (!host.contains(event.relatedTarget as Node | null)) close(); });
  for (const node of [clear, toggle]) node.onpointerdown = event => event.preventDefault();
  clear.onclick = () => { input.value = ''; updateClear(); options.onChange?.(''); input.focus(); show(); };
  toggle.onclick = () => { const opening = list.hidden; input.focus(); if (opening) show(); else close(); };
  updateClear();
  return { input, refresh: () => { if (!list.hidden) show(filtering); } };
}
