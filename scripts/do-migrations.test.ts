import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'jsonc-parser';

// Durable Object migrations, as each app's wrangler.jsonc declares them. Cloudflare applies a tag
// once per Worker and remembers it: editing or removing an applied tag doesn't undo it, it puts the
// config out of step with what runs, and a `deleted_classes` (or a rename or transfer gone wrong)
// destroys every object of that class in every deployment, live order state and carts included.
//
// The applied tags are frozen here as golden values, like the catalog's routing tests, rather than
// read from origin/main: CI's checkout is one commit with no origin/main to compare with, and a
// list in the test makes any change to it a visible line in review. A new class appends a tag to
// its app's wrangler.jsonc and the same entry here, in the same change. Never change or remove an
// entry below: once it has merged, every deployment has applied it.
const APPLIED: Record<string, Migration[]> = {
  engine: [
    { tag: 'v1', new_sqlite_classes: ['OrderAgent'] },
    { tag: 'v2', new_sqlite_classes: ['AssistantAgent'] },
    { tag: 'v3', new_sqlite_classes: ['A2AAgent'] },
    { tag: 'v4', new_sqlite_classes: ['PluginStorage'] },
    { tag: 'v5', new_sqlite_classes: ['CartAgent'] },
    { tag: 'v6', new_sqlite_classes: ['HealthProbe'] },
  ],
  catalog: [
    { tag: 'v1', new_sqlite_classes: ['CatalogShard', 'CatalogMeta'] },
    { tag: 'v2', new_sqlite_classes: ['CatalogFeeds'] },
    { tag: 'v3', new_sqlite_classes: ['ListingIndexer'] },
    { tag: 'v4', new_sqlite_classes: ['SearchShard'] },
    { tag: 'v5', new_sqlite_classes: ['CatalogPublisher'] },
  ],
};

// Migrations allowed to delete, rename or transfer a class, as `<app>:<tag>`. Empty, and it should
// stay so: one goes here only once what happens to that class's data has been planned with the
// user (moved first, or knowingly given up), with a comment saying so.
const DESTRUCTIVE_ALLOWED = new Set<string>([]);
const DESTRUCTIVE = ['deleted_classes', 'renamed_classes', 'transferred_classes'];

type Migration = { tag: string } & Record<string, unknown>;
type Config = {
  durable_objects?: { bindings: { name: string; class_name: string; script_name?: string }[] };
  migrations?: Migration[];
};

/** Why an app's config would put its Durable Objects at risk; empty when it keeps the rules. */
function migrationProblems(app: string, c: Config, applied: Migration[] = []): string[] {
  const where = `apps/${app}/wrangler.jsonc`;
  const migrations = c.migrations ?? [];
  const problems: string[] = [];
  applied.forEach((m, i) => {
    if (!isDeepStrictEqual(migrations[i], m))
      problems.push(
        `${where}: applied migration ${m.tag} was changed, moved or removed; every deployment has applied it, so it stays as it is (add a new tag at the end)`,
      );
  });
  for (const m of migrations.slice(applied.length))
    problems.push(
      `${where}: new migration ${m.tag} isn't frozen: append the same entry to APPLIED.${app} in scripts/do-migrations.test.ts`,
    );
  for (const m of migrations) {
    const used = DESTRUCTIVE.filter((k) => k in m);
    if (used.length && !DESTRUCTIVE_ALLOWED.has(`${app}:${m.tag}`))
      problems.push(
        `${where}: ${m.tag} uses ${used.join(', ')}, which destroys or moves every object of a class in every deployment; plan its data with the user first (DESTRUCTIVE_ALLOWED)`,
      );
  }
  const tags = migrations.map((m) => m.tag);
  if (new Set(tags).size !== tags.length) problems.push(`${where}: a migration tag is repeated`);
  const created = new Set(
    migrations.flatMap((m) => [
      ...((m.new_sqlite_classes as string[] | undefined) ?? []),
      ...((m.new_classes as string[] | undefined) ?? []),
    ]),
  );
  for (const b of c.durable_objects?.bindings ?? []) {
    // A binding with script_name is another Worker's class, migrated there.
    if (!b.script_name && !created.has(b.class_name))
      problems.push(
        `${where}: ${b.name} binds ${b.class_name}, which no migration creates: add a tag with new_sqlite_classes`,
      );
  }
  return problems;
}

const appsDir = join(import.meta.dirname, '..', 'apps');
const apps = readdirSync(appsDir).filter((a) => existsSync(join(appsDir, a, 'wrangler.jsonc')));
const config = (app: string): Config =>
  parse(readFileSync(join(appsDir, app, 'wrangler.jsonc'), 'utf8'));

test('every app with Durable Object migrations has its applied tags frozen here', () => {
  const withMigrations = apps.filter((a) => config(a).migrations?.length).sort();
  assert.deepEqual(withMigrations, Object.keys(APPLIED).sort());
});

for (const app of apps)
  test(`${app}: Durable Object migrations only ever append new classes`, () => {
    assert.deepEqual(migrationProblems(app, config(app), APPLIED[app]), []);
  });

const engine = { durable_objects: { bindings: [{ name: 'A', class_name: 'A' }] } };
const applied: Migration[] = [{ tag: 'v1', new_sqlite_classes: ['A'] }];
const check = (migrations: Migration[], c: Config = engine) =>
  migrationProblems('engine', { ...c, migrations }, applied).join('\n');

test('an applied migration changed, removed or moved is caught', () => {
  assert.equal(check(applied), '');
  assert.match(check([{ tag: 'v1', new_sqlite_classes: ['A', 'B'] }]), /v1 was changed/);
  assert.match(check([{ tag: 'v1b', new_sqlite_classes: ['A'] }]), /v1 was changed/);
  assert.match(check([]), /v1 was changed/);
  assert.match(
    check([{ tag: 'v0', new_sqlite_classes: ['Z'] }, ...applied]),
    /v1 was changed.*\n.*v1 isn't frozen/,
  );
});

test('a new migration must be frozen in the same change', () => {
  assert.match(
    check([...applied, { tag: 'v2', new_sqlite_classes: ['B'] }]),
    /new migration v2 isn't frozen/,
  );
  assert.equal(
    migrationProblems(
      'engine',
      { ...engine, migrations: [...applied, { tag: 'v2', new_sqlite_classes: ['B'] }] },
      [...applied, { tag: 'v2', new_sqlite_classes: ['B'] }],
    ).join('\n'),
    '',
  );
});

test('deleting, renaming or transferring a class is refused', () => {
  for (const [key, value] of [
    ['deleted_classes', ['A']],
    ['renamed_classes', [{ from: 'A', to: 'B' }]],
    ['transferred_classes', [{ from: 'A', from_script: 'x', to: 'A' }]],
  ] as const)
    assert.match(check([...applied, { tag: 'v2', [key]: value }]), new RegExp(`v2 uses ${key}`));
});

test('a bound class needs a migration; another Worker’s class does not', () => {
  const bindings = [
    { name: 'A', class_name: 'A' },
    { name: 'B', class_name: 'B' },
    { name: 'C', class_name: 'C', script_name: 'other' },
  ];
  assert.equal(
    check(applied, { durable_objects: { bindings } }),
    'apps/engine/wrangler.jsonc: B binds B, which no migration creates: add a tag with new_sqlite_classes',
  );
});

test('a repeated tag is caught', () => {
  assert.match(
    migrationProblems('engine', {
      migrations: [
        { tag: 'v1', new_sqlite_classes: ['A'] },
        { tag: 'v1', new_sqlite_classes: ['B'] },
      ],
    }).join('\n'),
    /tag is repeated/,
  );
});
