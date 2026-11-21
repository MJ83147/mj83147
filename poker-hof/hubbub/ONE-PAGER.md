# Poker HOF

## Aim
Opt-in poker leaderboards for Torn players at systoned.cc/poker-hof. Players sign in with their Torn API key, their poker log is read, and they are ranked by net money, sittings, average per sitting and time at the tables. Each player picks how much others see: public, hide money, hide name, or fully hidden.

## How it is built
- Static page `poker-hof/index.html` with its code in `poker-hof/app.js`, served by Cloudflare Pages.
- Server API at `/poker-hof/api` in `functions/poker-hof/api/[[path]].js`: auth, board, sittings, settings, delete.
- Cloudflare D1 database `poker-hof` (binding `DB`). Tables: players, sittings, hidden_tables, and totals, which is rebuilt when a player syncs so board reads stay cheap.
- Part of the systoned.cc site. Published with `Publish systoned.cc.command` in the systoned folder.

## Rules
- The Torn key stays in the player's browser. It is sent to the server only to prove who the player is.
- A sitting's id is the Torn join log entry id, so syncing the same history twice never counts it twice.
- The board reads the totals table, not the sittings table.
- No build step: plain static files.

## Key files
- `poker-hof/index.html`: the page (board, log in, sign up, profile).
- `poker-hof/app.js`: front end code, including reading the poker log in the browser.
- `poker-hof/schema.sql`: database tables.
- `functions/poker-hof/api/[[path]].js`: server API and table id to name list.
- `wrangler.toml`: Cloudflare settings and database binding.
