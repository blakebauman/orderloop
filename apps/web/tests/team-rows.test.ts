import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoutesStub, useFetcher } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const { RoleForm, RowActions } = await import('../app/routes/team');

const render = (Component: () => React.ReactNode) => {
  const Stub = createRoutesStub([{ path: '/team', Component }]);
  return renderToString(createElement(Stub, { initialEntries: ['/team'] }));
};

describe('a person on the Team page', () => {
  it('shows their role with no Save until it is changed', () => {
    const html = render(() =>
      createElement(RoleForm, {
        id: 'u_ada',
        name: 'Ada',
        role: 'operator',
        stepUp: null,
        fetcher: useFetcher(),
      }),
    );
    expect(html).toContain('aria-label="Role for Ada"');
    expect(html).not.toContain('Save');
  });

  it('keeps the resets and disabling in one menu, named for the person', () => {
    const html = render(() =>
      createElement(RowActions, {
        id: 'u_ada',
        name: 'Ada',
        self: false,
        twoFactor: true,
        disabled: false,
        ask: () => {},
      }),
    );
    // One control in the row; its items render only when it opens.
    expect(html).toContain('aria-label="Actions for Ada"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('data-ask="u_ada"');
    expect(html).not.toContain('Reset password');
    expect(html).not.toContain('Disable');
  });
});
