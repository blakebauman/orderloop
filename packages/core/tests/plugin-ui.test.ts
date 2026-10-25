import { describe, expect, it } from 'vitest';
import {
  checkPluginView,
  PLUGIN_VIEW_MAX_BYTES,
  type PluginView,
  pluginViewHref,
} from '../src/plugin-ui';

const check = (view: unknown) => checkPluginView(JSON.stringify(view));
const withLink = (href: string): PluginView => ({
  title: 'T',
  blocks: [{ type: 'list', items: [{ label: 'x', href }] }],
});
const withAction = (action: string): PluginView => ({
  title: 'T',
  blocks: [{ type: 'form', action, fields: [], submit: 'Go' }],
});

describe('plugin views', () => {
  it('accepts a page of every block, with defaults filled in', () => {
    const r = check({
      title: 'Partners',
      description: 'Who may punch out',
      actions: [{ label: 'Settings', href: 'settings' }],
      blocks: [
        { type: 'alert', tone: 'error', text: 'Nope' },
        { type: 'stats', items: [{ label: 'Partners', value: '3' }] },
        {
          type: 'section',
          title: 'Partners',
          blocks: [
            {
              type: 'table',
              columns: [{ key: 'name', label: 'Name' }],
              rows: [
                {
                  cells: { name: { text: 'Northwind', href: 'partners/ptn_1', tone: 'ok' } },
                  actions: [
                    { type: 'form', action: 'partners/ptn_1/rotate', fields: [], submit: 'Rotate' },
                  ],
                },
              ],
            },
            { type: 'code', label: 'Secret', text: 'abc' },
            { type: 'text', text: 'Hello' },
          ],
        },
        {
          type: 'form',
          action: 'partners',
          submit: 'Add',
          fields: [
            { name: 'name', label: 'Name', required: true },
            {
              name: 'protocol',
              label: 'Protocol',
              kind: 'select',
              options: [{ value: 'cxml', label: 'cXML' }],
            },
            { name: 'n', label: 'N', kind: 'number', value: 120 },
          ],
        },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [alert, , section, form] = r.view.blocks;
    expect(alert).toMatchObject({ type: 'alert', tone: 'error' });
    expect(section).toMatchObject({ type: 'section' });
    expect(form).toMatchObject({
      type: 'form',
      tone: 'default',
      fields: [{ kind: 'text' }, {}, {}],
    });
  });

  it('refuses what is not a view: not JSON, too large, an unknown block, markup in place of data', () => {
    expect(checkPluginView('<html>')).toEqual({ ok: false, error: 'The page is not JSON' });
    expect(checkPluginView(' '.repeat(PLUGIN_VIEW_MAX_BYTES + 1))).toEqual({
      ok: false,
      error: 'The page is too large',
    });
    expect(check({ title: 'T', blocks: [{ type: 'html', html: '<script>' }] }).ok).toBe(false);
    expect(check({ blocks: [] }).ok).toBe(false);
    const r = check({ title: 'T', blocks: [{ type: 'text', text: 1 }] });
    expect(r.ok ? '' : r.error).toMatch(/^blocks\.0\.text: /);
  });

  it('keeps links and form actions on the plugin’s own pages', () => {
    for (const ok of [
      'partners',
      'partners/ptn_1/rotate',
      '/plugins/punchout/x',
      'a/b?c=1',
      'a..b',
    ])
      expect([ok, check(withLink(ok)).ok]).toEqual([ok, true]);
    for (const bad of [
      'https://evil.example/',
      'javascript:alert(1)',
      'JAVASCRIPT:alert(1)',
      'data:text/html,x',
      '//evil.example/x',
      '..',
      '../admin',
      'a/../../admin',
      'a/..',
      '.',
      './x',
      '%2e%2e/admin',
      '.%2E/admin',
      'a\\..\\b',
      '#top',
      'a b',
      '',
    ]) {
      expect([bad, check(withLink(bad)).ok]).toEqual([bad, false]);
      expect([bad, check(withAction(bad)).ok]).toEqual([bad, false]);
    }
  });

  it('resolves a target under the plugin’s base, or not at all', () => {
    const base = '/plugins/punchout/';
    expect(pluginViewHref(base, 'partners')).toBe('/plugins/punchout/partners');
    expect(pluginViewHref(base, 'partners/ptn_1/rotate?x=1')).toBe(
      '/plugins/punchout/partners/ptn_1/rotate?x=1',
    );
    expect(pluginViewHref(base, '/plugins/punchout/')).toBe('/plugins/punchout/');
    expect(pluginViewHref(base, '/plugins/other/')).toBeNull();
    expect(pluginViewHref(base, '/orders')).toBeNull();
    expect(pluginViewHref(base, '/plugins/punchout/../other/')).toBeNull();
    expect(pluginViewHref(base, '/plugins/punchout/%2e%2e/other/')).toBeNull();
    // Safe on its own, not only after the view's check.
    expect(pluginViewHref(base, '/plugins/punchout/\\..\\..\\team')).toBeNull();
    expect(pluginViewHref(base, 'javascript:alert(1)')).toBeNull();
    expect(pluginViewHref(base, 'a b')).toBeNull();
    expect(pluginViewHref('', 'https://evil.example/')).toBeNull();
    expect(pluginViewHref('', '/team')).toBeNull();
    expect(pluginViewHref('/', '/team')).toBeNull();
  });
});
