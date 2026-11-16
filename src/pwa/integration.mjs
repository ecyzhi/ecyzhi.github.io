// Astro integration that writes dist/sw.js after the build, from src/pwa/sw.js,
// with a precache list of every page and asset in dist and a version hash of
// their contents and of the worker itself (so any change ships a new service worker).
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SKIP = new Set(['sw.js', 'flutter_service_worker.js', 'CNAME', 'robots.txt']);
const SKIP_PREFIX = ['sitemap'];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

export default function serviceWorker() {
  return {
    name: 'ecyzhi-service-worker',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const template = await readFile(new URL('./sw.js', import.meta.url), 'utf8');
        const hash = createHash('sha256').update(template);
        const urls = [];
        for (const file of (await walk(root)).sort()) {
          const rel = relative(root, file).split(sep).join('/');
          if (SKIP.has(rel) || SKIP_PREFIX.some((p) => rel.startsWith(p))) continue;
          hash.update(rel).update(await readFile(file));
          // Pages are cached under their clean URL: about/index.html -> /about/
          urls.push('/' + rel.replace(/(^|\/)index\.html$/, '$1'));
        }
        const version = hash.digest('hex').slice(0, 12);
        const sw = template
          .replace("'__VERSION__'", JSON.stringify(version))
          .replace('__PRECACHE__', JSON.stringify(urls, null, 2));
        await writeFile(join(root, 'sw.js'), sw);
        logger.info(`sw.js written: ${urls.length} files precached, version ${version}`);
      },
    },
  };
}
