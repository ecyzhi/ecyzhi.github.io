// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import serviceWorker from './src/pwa/integration.mjs';

export default defineConfig({
  site: 'https://ecyzhi.com',
  output: 'static',
  trailingSlash: 'ignore',
  // The tools hub is now the home page; keep old /tools/ links working.
  redirects: { '/tools': '/#all' },
  integrations: [react(), sitemap(), serviceWorker()],
});
