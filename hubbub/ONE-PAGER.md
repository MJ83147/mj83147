# Systoned

## Aim
The website at systoned.cc. It holds Torn poker tools and event pages for Torn players.

## How it is built
- Plain static HTML files at the project root, with no build step.
- Hosted on Cloudflare Pages. Published by double-clicking `Publish systoned.cc.command`.
- Each tool or event has its own folder: `rope/`, `thuc/`, `scripts/`, `shootout/`.
- The Progressive Shootout pages read and write data through a Google Apps Script web app. Its URL is set in `shootout/config.js`.

## Rules
- Keep the site as plain static files with no build step.
- `shootout/appscript.gs` stays local only. It is edited in the Apps Script editor.

## Key files
- `index.html`: home page with the links to each tool.
- `Publish systoned.cc.command`: publishes the site to Cloudflare.
- `wrangler.toml`: Cloudflare Pages settings.
- `shootout/config.js`: the Apps Script URL used by all Shootout pages.
- `scripts/index.html`: the userscripts page.
