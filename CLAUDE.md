# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

The GitHub Pages deployment for the personal site at `ecyzhi.com` (see `CNAME`). There is no build system, package manager, linter, or test suite at the repo root — everything here is served as static files straight from `master`.

The root of the site is **compiled Flutter web output**, not source. The Flutter source project (`ecyzhi_flutter`, per `version.json`) lives elsewhere and is not in this repo.

## Layout

- **Root (`/`) — Flutter web build artifacts.** `index.html`, `main.dart.js`, `flutter.js`, `flutter_service_worker.js`, `canvaskit/`, `assets/` (incl. `AssetManifest.*`, `FontManifest.json`, `NOTICES`), `manifest.json`, `icons/`, `.last_build_id`, `version.json`. These are produced by `flutter build web` in the separate source repo and copied over wholesale. Do not hand-edit `main.dart.js`, `flutter_service_worker.js` (its resource hashes must match the files), or the asset manifests; content changes to the portfolio belong in the Flutter source, followed by a rebuild and copy.
  - Flutter asset paths are doubled: a source asset `assets/images/x.svg` is served at `assets/assets/images/x.svg`. Files directly under `assets/` (e.g. `assets/logo/`, `assets/resume/Resume.pdf`) are hand-placed and referenced by absolute URL from the non-Flutter pages (e.g. `v1/` uses `/assets/logo/logo.svg`).
  - Renaming an asset (like the resume) requires updating it in the Flutter source and redeploying the build, since the asset manifest and service worker hashes reference it.
- **`v1/`** — the previous, deprecated hand-written portfolio (plain HTML/CSS/JS; uses typed.js, feather-icons, animate.css from CDNs).
- **`blogs/`** — standalone hand-written HTML blog posts sharing `blog_style.css`. Posts link back to the Flutter app via `../#blogs`; the Flutter app links out to them.
- **`ai_tee/`** — a standalone Bootstrap 5 landing page for the AI-Tee project. `scss/custom.scss` imports `_variables.scss`, a vendored copy of Bootstrap's SCSS in `ai_tee/bootstrap-scss/`, and a Bootswatch theme; the compiled `scss/custom.css` (+ `.map`) is committed and is what `index.html` loads. After editing the SCSS, recompile with any Sass compiler, e.g.:
  ```bash
  npx sass ai_tee/scss/custom.scss ai_tee/scss/custom.css
  ```
  Treat `ai_tee/bootstrap-scss/` as vendored third-party code.

## Serving / previewing

Any static file server from the repo root works; the Flutter app expects to be served at `/` (`<base href="/">` in `index.html`), so open it at the server root, not via `file://`.

```bash
npx serve .
```

`.htaccess` contains Apache rewrite rules for extensionless `.html` URLs; GitHub Pages ignores it, so don't rely on it.
