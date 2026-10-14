import { type SQL, type SQLWrapper, sql } from 'drizzle-orm';

/** `text` with LIKE's wildcards (`%`, `_`) and the escape character itself taken literally. */
const literal = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `column LIKE '%text%'`, with `text` matched literally. */
export const contains = (column: SQLWrapper, text: string): SQL =>
  sql`${column} like ${`%${literal(text)}%`} escape '\\'`;

/** `column LIKE 'text%'`, with `text` matched literally. */
export const startsWith = (column: SQLWrapper, text: string): SQL =>
  sql`${column} like ${`${literal(text)}%`} escape '\\'`;

/** `column LIKE '%text'`, with `text` matched literally. */
export const endsWith = (column: SQLWrapper, text: string): SQL =>
  sql`${column} like ${`%${literal(text)}`} escape '\\'`;
