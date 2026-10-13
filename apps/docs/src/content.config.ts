// Starlight docs collection. Prose lives at src/content/ rather than src/content/docs/, so the
// collection uses a glob loader instead of Starlight's docsLoader() (which hardcodes the latter).

import { defineCollection } from 'astro:content';
import { docsSchema } from '@astrojs/starlight/schema';
import { glob } from 'astro/loaders';

export const collections = {
  docs: defineCollection({
    loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content' }),
    schema: docsSchema(),
  }),
};
