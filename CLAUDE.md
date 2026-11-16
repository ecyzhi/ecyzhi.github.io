# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Source for the personal site at `ecyzhi.com`: an [Astro](https://astro.build) static site with React islands for the in-browser tools. GitHub Actions builds it and deploys `dist/` to GitHub Pages (`.github/workflows/deploy.yml`, on push to `master`). The custom domain comes from `public/CNAME`.

Design style is "Midnight Workshop": dark `#0D0E11` ground, logo yellow `#FFE14D` as the only accent, Inter for text and JetBrains Mono for labels (self-hosted via `@fontsource-variable`). Tokens live in `src/styles/global.css`; reuse them rather than hard-coding colours.

## Commands

```bash
npm install
npm run dev      # local dev server at http://localhost:4321
npm run check    # astro check (TypeScript + .astro diagnostics)
npm run build    # static output in dist/
npm run preview  # serve dist/
```

There is no test suite. `npm run check && npm run build` is what CI runs on pull requests.

## Layout

- `src/pages/` — routes. `index.astro` (home: hero, tools, about, experience, contact), `about.astro`, `resume.astro`, `tools/index.astro` (hub), `tools/<slug>.astro` (one page per tool), `404.astro`.
- `src/data/` — content. `site.ts` (name, links, resume path), `experience.ts` (roles and skills), `tools.ts` (tool list in ship order; `live: false` shows as "soon").
- `src/components/` — Astro components shared by pages (header, footer, tool card, experience list, contact block).
- `src/tools/<slug>/` — each tool's React editor, mounted with `client:only="react"` so no JS loads on non-tool pages. `src/tools/shared/` holds code meant for reuse by later media tools (file drop zone, image loading, PNG export and download).
- `public/` — copied as is: `CNAME`, favicon and app icons, `assets/resume/Resume.pdf`, and `flutter_service_worker.js`.
- `src/pages/manifest.webmanifest.ts` — the PWA manifest, built from `site.ts` and `tools.ts` (live tools become home-screen shortcuts).
- `src/pwa/` — the service worker. `sw.js` is a template; `integration.mjs` writes `dist/sw.js` after each build with a precache list of every file in `dist` and a content hash as its version, so the whole site works offline after one visit. It only registers in production builds.

## Adding a tool

1. Build the editor in `src/tools/<slug>/` as a React component. Everything must run in the browser; files never leave the device.
2. Add `src/pages/tools/<slug>.astro` using `Base` layout and mount the editor with `client:only="react"`.
3. Set `live: true` for it in `src/data/tools.ts`.
4. It must work with touch and mouse on phone and desktop widths.

## Things to keep

- `public/flutter_service_worker.js` is a self-unregistering kill switch for the old Flutter site's service worker. Keep it at that path so returning visitors' browsers drop the cached old site. `/sw.js` shares its scope, so registering it also replaces the old worker, and its activate step deletes the old caches.
- App icons (`favicon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`) are the "e." mark: JetBrains Mono ExtraBold "e" in `#ECEDEF` with the yellow dot, on `#0D0E11`. Keep the maskable one's content inside the central 80% circle.
- The resume stays at `/assets/resume/Resume.pdf` (old links point there).
- No mention of AI-Tee, and no Projects or Blog pages for now.
