import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoutesStub } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const { Upload } = await import('../app/routes/plugins');

const render = (publishers: string[]) => {
  const Stub = createRoutesStub([
    { path: '/plugins', Component: () => createElement(Upload, { publishers }) },
  ]);
  return renderToString(createElement(Stub, { initialEntries: ['/plugins'] }));
};

describe('Install from a file', () => {
  it('says why nothing can be installed, and who can change it, with no trusted publisher', () => {
    const html = render([]);
    expect(html).toContain('Installing from a file is off');
    expect(html).toContain('ask whoever runs your OrderLoop workspace to trust its publisher');
    // No form that every upload would be refused by.
    expect(html).not.toContain('type="file"');
  });

  it('offers the upload, naming who it trusts, once a publisher is trusted', () => {
    const html = render(['acme']);
    expect(html).toContain('type="file"');
    expect(html).toContain('signed by acme');
    expect(html).not.toContain('Installing from a file is off');
  });
});
