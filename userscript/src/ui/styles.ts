/**
 * Panel styles. All selectors are namespaced under `dspp-` and the panel is
 * mounted in a shadow root, so DeepSeek's own stylesheet cannot leak in or out.
 */

export const PANEL_STYLES = `
:host {
  all: initial;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }

.dspp-fab {
  position: fixed;
  right: 20px;
  bottom: 96px;
  z-index: 2147483000;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: none;
  cursor: pointer;
  background: linear-gradient(135deg, #4d6bfe, #3b5bdb);
  color: #fff;
  font-size: 18px;
  font-weight: 600;
  box-shadow: 0 6px 20px rgba(77, 107, 254, 0.35);
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}
.dspp-fab:hover { transform: translateY(-2px); box-shadow: 0 10px 26px rgba(77,107,254,.45); }
.dspp-fab:active { transform: translateY(0); }

.dspp-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.dspp-overlay[hidden] { display: none; }

.dspp-panel {
  width: min(880px, 100%);
  max-height: min(760px, 92vh);
  display: flex;
  flex-direction: column;
  background: var(--dspp-bg, #ffffff);
  color: var(--dspp-fg, #1f2937);
  border-radius: 14px;
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
  overflow: hidden;
}

.dspp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dspp-border, #e5e7eb);
}
.dspp-title { font-size: 15px; font-weight: 650; }
.dspp-close {
  border: none; background: transparent; cursor: pointer;
  font-size: 20px; line-height: 1; color: var(--dspp-muted, #6b7280); padding: 4px 8px;
  border-radius: 6px;
}
.dspp-close:hover { background: var(--dspp-hover, #f3f4f6); }

.dspp-tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid var(--dspp-border,#e5e7eb); }
.dspp-tab {
  border: none; background: transparent; cursor: pointer;
  padding: 8px 14px; font-size: 13px; border-radius: 8px 8px 0 0;
  color: var(--dspp-muted, #6b7280);
}
.dspp-tab:hover { background: var(--dspp-hover, #f3f4f6); }
.dspp-tab.is-active { color: var(--dspp-accent, #4d6bfe); font-weight: 600; background: var(--dspp-hover, #f3f4f6); }

.dspp-body { flex: 1; overflow-y: auto; padding: 16px 20px 20px; }

.dspp-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
.dspp-search { flex: 1; min-width: 200px; }

input[type="text"], input[type="search"], textarea, select {
  width: 100%;
  padding: 8px 10px;
  font-size: 13px;
  font-family: inherit;
  color: inherit;
  background: var(--dspp-input-bg, #fff);
  border: 1px solid var(--dspp-border, #d1d5db);
  border-radius: 8px;
  outline: none;
}
input:focus, textarea:focus, select:focus { border-color: var(--dspp-accent, #4d6bfe); }
textarea { resize: vertical; min-height: 90px; line-height: 1.5; }

.dspp-btn {
  border: 1px solid var(--dspp-border, #d1d5db);
  background: var(--dspp-input-bg, #fff);
  color: inherit;
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}
.dspp-btn:hover { background: var(--dspp-hover, #f3f4f6); }
.dspp-btn.is-primary { background: var(--dspp-accent, #4d6bfe); border-color: var(--dspp-accent,#4d6bfe); color: #fff; }
.dspp-btn.is-primary:hover { filter: brightness(1.05); }
.dspp-btn.is-danger { color: #dc2626; }
.dspp-btn.is-small { padding: 4px 8px; font-size: 12px; }

.dspp-list { display: flex; flex-direction: column; gap: 10px; }
.dspp-card {
  border: 1px solid var(--dspp-border, #e5e7eb);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--dspp-card-bg, #fff);
}
.dspp-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.dspp-card-name { font-weight: 600; font-size: 13px; flex: 1; word-break: break-word; }
.dspp-card-content { font-size: 13px; line-height: 1.55; color: var(--dspp-fg,#374151); white-space: pre-wrap; word-break: break-word; }
.dspp-card-meta { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; align-items: center; }
.dspp-card-actions { display: flex; gap: 6px; }

.dspp-badge {
  font-size: 11px; padding: 2px 7px; border-radius: 999px;
  background: var(--dspp-hover, #f3f4f6); color: var(--dspp-muted, #6b7280);
}
.dspp-badge.is-pinned { background: #fef3c7; color: #92400e; }
.dspp-badge.is-user { background: #dbeafe; color: #1e40af; }
.dspp-badge.is-feedback { background: #fee2e2; color: #991b1b; }
.dspp-badge.is-topic { background: #dcfce7; color: #166534; }
.dspp-badge.is-reference { background: #ede9fe; color: #5b21b6; }

.dspp-empty { text-align: center; color: var(--dspp-muted, #6b7280); font-size: 13px; padding: 40px 16px; }
.dspp-stats { font-size: 12px; color: var(--dspp-muted, #6b7280); margin-bottom: 10px; }

.dspp-field { margin-bottom: 12px; }
.dspp-field label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 5px; color: var(--dspp-muted,#6b7280); }
.dspp-row { display: flex; gap: 10px; }
.dspp-row > * { flex: 1; }

.dspp-switch { display: flex; align-items: center; gap: 10px; padding: 10px 0; font-size: 13px; }
.dspp-switch input { width: auto; }
.dspp-switch-label { flex: 1; }

.dspp-form-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 14px; }

.dspp-toast-host {
  position: fixed;
  right: 20px;
  bottom: 150px;
  z-index: 2147483200;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}
.dspp-toast {
  background: rgba(17, 24, 39, 0.92);
  color: #fff;
  font-size: 12.5px;
  padding: 8px 14px;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0,0,0,.24);
  animation: dspp-toast-in .18s ease;
  max-width: 320px;
  word-break: break-word;
}
@keyframes dspp-toast-in {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

.dspp-hint { font-size: 12px; color: var(--dspp-muted,#6b7280); line-height: 1.6; }
.dspp-hint code {
  background: var(--dspp-hover,#f3f4f6); padding: 1px 5px; border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px;
}

/* Dark theme: DeepSeek sets data-theme / prefers-color-scheme. */
:host([data-theme="dark"]) .dspp-panel,
:host([data-theme="dark"]) .dspp-card {
  --dspp-bg: #1f2023;
  --dspp-fg: #e5e7eb;
  --dspp-muted: #9ca3af;
  --dspp-border: #383a40;
  --dspp-hover: #2b2d31;
  --dspp-card-bg: #26282c;
  --dspp-input-bg: #1a1b1e;
}
:host([data-theme="dark"]) .dspp-panel { background: #1f2023; color: #e5e7eb; }
`;
