import type { APIRoute } from 'astro';
import { site } from '../data/site';
import { tools } from '../data/tools';

// Web app manifest: lets Android and desktop browsers install the site as an
// app. Built from site.ts and tools.ts so new tools show up as shortcuts.
export const GET: APIRoute = () => {
  const manifest = {
    id: '/',
    name: `${site.handle} · ${site.name}`,
    short_name: site.handle,
    description: site.description,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#0D0E11',
    theme_color: '#0D0E11',
    categories: ['utilities', 'productivity'],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'All tools', url: '/tools/', icons: [{ src: '/icon-192.png', sizes: '192x192' }] },
      ...tools
        .filter((t) => t.live)
        .map((t) => ({ name: t.name, description: t.blurb, url: `/tools/${t.slug}/`, icons: [{ src: '/icon-192.png', sizes: '192x192' }] })),
    ],
  };
  return new Response(JSON.stringify(manifest, null, 2), {
    headers: { 'Content-Type': 'application/manifest+json' },
  });
};
