// Order Loop docs: Starlight over MDX in src/content/. Static output, deployed as a Workers
// static-assets site (wrangler.jsonc). Reference pages render from @orderloop/core at build time,
// so the node catalog, policy rules and event names can't drift from the code.
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://docs.orderloop.io',
  // No image transforms: the default service needs `sharp`, a native dependency these docs
  // don't otherwise need.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Order Loop',
      logo: {
        light: './src/assets/mark-light.svg',
        dark: './src/assets/mark-dark.svg',
        alt: '',
      },
      description:
        'Order Loop: a durable agent loop for the commerce order lifecycle, built on Cloudflare Workers, Workflows, Durable Objects, Workers AI, D1 and R2.',
      // Prose lives at src/content/ (see content.config.ts). Without this Starlight skips its
      // Markdown transforms (asides, heading anchors) for files outside src/content/docs/.
      markdown: { processedDirs: ['./src/content'] },
      expressiveCode: { defaultProps: { frame: 'code' } },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/blakebauman/orderloop' },
      ],
      components: {
        // Ledger is light by default with a light/dark switch; Starlight's pair follows the OS.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
      },
      customCss: ['./src/styles/ledger.css'],
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' } },
        { tag: 'link', attrs: { rel: 'preconnect', href: 'https://fonts.googleapis.com' } },
        {
          tag: 'link',
          attrs: { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
        },
        // The faces the web app sets (apps/web/app/root.tsx).
        {
          tag: 'link',
          attrs: {
            rel: 'stylesheet',
            href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Serif:wght@600&family=IBM+Plex+Mono:wght@400;500;600&display=swap',
          },
        },
      ],
      // Explicit sidebar: autogenerate expects src/content/docs/. A new page is invisible until
      // it is listed here. Start reads as a sequence (Starlight's prev/next follows this order).
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'start/getting-started' },
            { label: 'Concepts', slug: 'start/concepts' },
            { label: 'Deploy', slug: 'start/deploy' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Building flows', slug: 'guides/building-flows' },
            { label: 'Built-in flows', slug: 'guides/templates' },
            { label: 'Approvals and events', slug: 'guides/approvals-and-events' },
            { label: 'Email intake', slug: 'guides/email-intake' },
            { label: 'Outbound webhooks', slug: 'guides/outbound-webhooks' },
            { label: 'AI nodes and the copilot', slug: 'guides/ai' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'REST API', slug: 'reference/rest-api' },
            { label: 'Node catalog', slug: 'reference/nodes' },
            { label: 'Expressions and policy rules', slug: 'reference/expressions' },
            { label: 'Configuration', slug: 'reference/configuration' },
            // Scalar over the OpenAPI document generated from apps/web (src/pages/api.astro).
            { label: 'OpenAPI explorer', link: '/api/' },
          ],
        },
        {
          label: 'Internals',
          collapsed: true,
          items: [
            { label: 'Architecture', slug: 'internals/architecture' },
            { label: 'Planner', slug: 'internals/planner' },
            { label: 'OrderLoop Workflow', slug: 'internals/workflow' },
            { label: 'OrderAgent', slug: 'internals/order-agent' },
            { label: 'Data model', slug: 'internals/data-model' },
            { label: 'Testing', slug: 'internals/testing' },
          ],
        },
      ],
    }),
  ],
});
