/**
 * Lightweight activity toasts.
 *
 * The extension surfaced memory activity in its side panel; the userscript has
 * no side panel, so a transient toast is the feedback channel that tells the
 * user "N memories were injected" or "a memory was saved".
 */

const TOAST_VISIBLE_MS = 2600;

let host: HTMLElement | null = null;

export function createToastHost(root: ShadowRoot): void {
  const element = document.createElement('div');
  element.className = 'dspp-toast-host';
  root.appendChild(element);
  host = element;
}

export function showToast(message: string): void {
  if (!host || !message) return;
  const toast = document.createElement('div');
  toast.className = 'dspp-toast';
  toast.textContent = message;
  host.appendChild(toast);
  setTimeout(() => {
    toast.remove();
  }, TOAST_VISIBLE_MS);
}
