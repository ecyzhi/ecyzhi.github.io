// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://ecyzhi.com',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [react(), sitemap()],
});
