/**
 * What the engine says to people about an order: its reason, and counts in step summaries. An
 * order's reason is shown on one line in the overview and the orders list and sent in webhooks, so
 * it is a short summary; the full error stays on the step's run (`NodeRun.error`) and the log.
 */

/** The longest reason an order keeps. */
export const REASON_MAX = 200;

/** Errors from the database driver: a statement, its parameters and SQLite codes, never for people. */
const DATABASE_ERROR = /Failed query:|\bD1_[A-Z_]*ERROR\b|\bSQLITE_[A-Z_]+\b/;

/**
 * One line of at most `max` characters, cut at a word with "…". Whitespace runs collapse, so a
 * multi-line message reads as one sentence.
 */
export function capReason(text: string, max = REASON_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  // Cut at the last word unless that drops most of the line (one very long token).
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.·-]+$/, '')}…`;
}

/**
 * The reason a failed step gives its order: "Supplier cost: Insufficient stock for WID-100". A
 * database error names only where it happened, since its message is the SQL statement and its
 * parameters; anything else keeps its first line (never a stack), capped.
 */
export function failureReason(label: string, message: string): string {
  if (DATABASE_ERROR.test(message)) return capReason(`Database error at ${label}`);
  const first = message.split('\n').find((l) => l.trim()) ?? '';
  return capReason(first.trim() ? `${label}: ${first}` : `${label} failed`);
}

/**
 * Any reason as an order keeps it, whoever reported it: capped, and a database error cut back to
 * where it happened ("Extract: Failed query: select …" reads "Database error at Extract").
 */
export function orderReason(text: string): string {
  const db = DATABASE_ERROR.exec(text);
  if (!db) return capReason(text);
  const where = text.slice(0, db.index).replace(/[\s:]+$/, '');
  return capReason(where ? `Database error at ${where}` : 'Database error');
}

/** "1 reservation" / "3 reservations". */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
