/**
 * Whether a single-key page shortcut ("/", J, K, F) may act on this key press: not with ⌘, Ctrl or
 * Alt held (those belong to the browser and the system, on an iPad keyboard too), not while typing
 * in a field, and not while a dialog or sheet is open over the page (More, a menu, a confirmation).
 */
export function pageShortcut(e: KeyboardEvent) {
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return false;
  const el = e.target instanceof Element ? e.target : null;
  if (el?.closest('input, textarea, select, [contenteditable="true"]')) return false;
  return !document.querySelector(
    '[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="alertdialog"], dialog[open]',
  );
}
