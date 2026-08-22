/**
 * Tiny DOM helpers.
 *
 * The extension used React; bundling React into a userscript would multiply
 * its size for a handful of forms, so the panel is built with direct DOM
 * construction. `el` keeps that readable and, importantly, never assigns
 * untrusted strings to innerHTML.
 */

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Partial<Record<string, unknown>> & {
    class?: string;
    text?: string;
    on?: Record<string, EventListener>;
    attrs?: Record<string, string>;
  },
  children?: Child[],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    const { class: className, text, on, attrs, ...rest } = props;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [key, value] of Object.entries(rest)) {
      if (value === undefined || value === null) continue;
      (node as unknown as Record<string, unknown>)[key] = value;
    }
    for (const [key, value] of Object.entries(attrs ?? {})) {
      node.setAttribute(key, value);
    }
    for (const [event, handler] of Object.entries(on ?? {})) {
      node.addEventListener(event, handler);
    }
  }
  for (const child of children ?? []) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Formats a timestamp as a short local date-time. */
export function formatTimestamp(value: number): string {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  const pad = (input: number) => String(input).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJsonFile(): Promise<unknown | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)));
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    });
    input.click();
  });
}
