import { constrainSidebarWidth, defaultSidebarWidth, maxSidebarWidth, minSidebarWidth } from './model';

export function resizableSidebar(root: HTMLElement, divider: HTMLElement, options: {
  read: () => number; commit: (width: number) => void;
}): { refresh: () => void } {
  let preferredWidth = options.read();
  let drag: { pointerId: number; startWidth: number; offset: number; nextWidth?: number } | undefined;
  let frame = 0;
  function render(): void {
    const width = constrainSidebarWidth(preferredWidth, root.clientWidth);
    root.style.setProperty('--sidebar-width', `${width}px`);
    divider.setAttribute('aria-valuenow', String(width));
    divider.setAttribute('aria-valuetext', `${width} 像素`);
    divider.setAttribute('aria-valuemin', String(minSidebarWidth));
    divider.setAttribute('aria-valuemax', String(constrainSidebarWidth(maxSidebarWidth, root.clientWidth)));
  }
  function applyDrag(): void {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (drag?.nextWidth !== undefined) {
      preferredWidth = constrainSidebarWidth(drag.nextWidth, root.clientWidth);
      drag.nextWidth = undefined; render();
    }
  }
  function finish(commit: boolean): void {
    if (!drag) return;
    applyDrag();
    const previous = drag; drag = undefined;
    root.classList.remove('resizing-sidebar');
    if (divider.hasPointerCapture(previous.pointerId)) divider.releasePointerCapture(previous.pointerId);
    if (!commit) { preferredWidth = previous.startWidth; render(); }
    else if (preferredWidth !== previous.startWidth) options.commit(preferredWidth);
  }
  divider.onpointerdown = event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault(); divider.focus({ preventScroll: true });
    drag = { pointerId: event.pointerId, startWidth: preferredWidth,
      offset: event.clientX - (root.getBoundingClientRect().left + Number(divider.getAttribute('aria-valuenow'))) };
    divider.setPointerCapture(event.pointerId); root.classList.add('resizing-sidebar');
  };
  divider.onpointermove = event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag.nextWidth = event.clientX - root.getBoundingClientRect().left - drag.offset;
    if (!frame) frame = requestAnimationFrame(applyDrag);
  };
  divider.onpointerup = event => { if (drag?.pointerId === event.pointerId) finish(true); };
  divider.onpointercancel = event => { if (drag?.pointerId === event.pointerId) finish(false); };
  divider.onlostpointercapture = () => finish(false);
  window.addEventListener('blur', () => finish(false));
  divider.ondblclick = () => {
    finish(false); preferredWidth = defaultSidebarWidth; render(); options.commit(preferredWidth);
  };
  divider.onkeydown = event => {
    if (event.key === 'Escape' && drag) { event.preventDefault(); finish(false); return; }
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(event.key) || drag) return;
    event.preventDefault();
    const current = Number(divider.getAttribute('aria-valuenow'));
    const step = event.shiftKey ? 30 : 10;
    const width = event.key === 'Home' ? minSidebarWidth : event.key === 'End' ? maxSidebarWidth
      : event.key === 'Enter' ? defaultSidebarWidth : current + (event.key === 'ArrowLeft' ? -step : step);
    preferredWidth = constrainSidebarWidth(width, root.clientWidth); render(); options.commit(preferredWidth);
  };
  // Retain the preferred width when a temporarily smaller window constrains it.
  new ResizeObserver(render).observe(root);
  render();
  return { refresh: () => { preferredWidth = options.read(); render(); } };
}
