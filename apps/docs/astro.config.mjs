// OrderLoop docs: Starlight over MDX in src/content/. Static output, deployed as a Workers
// static-assets site (wrangler.jsonc). Reference pages render from @orderloop/core at build time,
// so the node catalog, policy rules and event names can't drift from the code.
import starlight from '@astrojs/starlight';
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://docs.orderloop.app',
  // No image transforms: the default service needs `sharp`, a native dependency these docs
  // don't otherwise need.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'OrderLoop',
      logo: {
        light: './src/assets/mark-light.svg',
        dark: './src/assets/mark-dark.svg',
        alt: '',
      },
      description:
        'OrderLoop: a durable agent loop for the commerce order lifecycle. Guides for the people who use it and reference for the systems that integrate with it.',
      // Prose lives at src/content/ (see content.config.ts). Without this Starlight skips its
      // Markdown transforms (asides, heading anchors) for files outside src/content/docs/.
      markdown: { processedDirs: ['./src/content'] },
      // Code blocks on the app's card ground with its hairline and corners. GitHub's themes keep
      // syntax colour quiet next to Ledger's ink; Night Owl (Starlight's default) did not.
      expressiveCode: {
        themes: ['github-light', 'github-dark-dimmed'],
        defaultProps: { frame: 'code' },
        styleOverrides: {
          borderColor: 'var(--ol-rule)',
          borderRadius: 'var(--ol-radius)',
          codeBackground: 'var(--ol-card)',
          codeFontFamily: 'var(--sl-font-mono)',
          codeFontSize: '0.8125rem',
          uiFontFamily: 'var(--sl-font)',
          frames: {
            editorBackground: 'var(--ol-card)',
            editorActiveTabBackground: 'var(--ol-card)',
            editorTabBarBackground: 'var(--ol-muted)',
            editorTabBarBorderBottomColor: 'var(--ol-rule)',
            frameBoxShadowCssValue: 'none',
            inlineButtonBorder: 'var(--ol-rule)',
          },
        },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/blakebauman/orderloop' },
      ],
      components: {
        // The web app's theme rule: light by default, then Dark or Match system.
        ThemeProvider: './src/components/ThemeProvider.astro',
        ThemeSelect: './src/components/ThemeSelect.astro',
        // The app's page header: the title, muted description under it.
        PageTitle: './src/components/PageTitle.astro',
        // The app's top-bar links: API explorer, then "Open the app" as the one ink button.
        SocialIcons: './src/components/SocialIcons.astro',
      },
      // The app's faces, self-hosted (the docs fetch no font from a third party), then Ledger:
      // theme.css is generated from @orderloop/design (`pnpm sync:theme`); brand.css is hand-written.
      customCss: [
        '@fontsource/ibm-plex-sans/400.css',
        '@fontsource/ibm-plex-sans/500.css',
        '@fontsource/ibm-plex-sans/600.css',
        '@fontsource/ibm-plex-mono/400.css',
        '@fontsource/ibm-plex-mono/500.css',
        './src/styles/theme.css',
        './src/styles/brand.css',
      ],
      head: [{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' } }],
      // Explicit sidebar: autogenerate expects src/content/docs/. A new page is invisible until
      // it is listed here. Start reads as a sequence (Starlight's prev/next follows this order).
      // The site is for people who use a workspace and developers who integrate with one;
      // deployment, configuration and internals live in the repo's docs/ folder, unpublished.
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Getting started', slug: 'start/getting-started' },
            { label: 'Concepts', slug: 'start/concepts' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Building flows', slug: 'guides/building-flows' },
            { label: 'Commerce models', slug: 'guides/commerce-models' },
            { label: 'Fulfillment', slug: 'guides/fulfillment' },
            { label: 'Built-in flows', slug: 'guides/templates' },
            { label: 'Marketplace', slug: 'guides/marketplace' },
            { label: 'Payments', slug: 'guides/payments' },
            { label: 'Approvals and events', slug: 'guides/approvals-and-events' },
            { label: 'Inbound orders', slug: 'guides/inbound-orders' },
            { label: 'Channel adapters', slug: 'guides/channel-adapters' },
            { label: 'Email intake', slug: 'guides/email-intake' },
            { label: 'Outbound webhooks', slug: 'guides/outbound-webhooks' },
            { label: 'AI nodes and the assistant', slug: 'guides/ai' },
            { label: 'The assistant', slug: 'guides/assistant' },
            { label: 'Team and roles', slug: 'guides/team-and-roles' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'REST API', slug: 'reference/rest-api' },
            { label: 'Node catalog', slug: 'reference/nodes' },
            { label: 'Expressions and policy rules', slug: 'reference/expressions' },
            { label: 'MCP server', slug: 'reference/mcp' },
            { label: 'A2A endpoint', slug: 'reference/a2a' },
            // Scalar over the OpenAPI document generated from apps/web (src/pages/api.astro).
            { label: 'OpenAPI explorer', link: '/api/' },
          ],
        },
      ],
    }),
  ],
});
