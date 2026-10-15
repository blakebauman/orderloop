// The orderloop.app marketing page. Static output, deployed as a Workers static-assets site
// (wrangler.jsonc). The flow graph, templates and catalog facts render from @orderloop/core at build
// time, so the page can't drift from the product.
import { defineConfig, passthroughImageService } from 'astro/config';

export default defineConfig({
  site: 'https://orderloop.app',
  // No image transforms: the default service needs `sharp`, which this page doesn't otherwise need.
  image: { service: passthroughImageService() },
});
