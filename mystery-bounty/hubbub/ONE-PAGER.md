# Mystery Bounty

## Aim
Pages and a server for running a Mystery Bounty poker tournament for Torn players at systoned.cc/mystery-bounty, used by players, stewards and the organisers.

## How it is built
- Static pages in `mystery-bounty/`, served by Cloudflare Pages.
- Server API at `/mystery-bounty/api` in `functions/mystery-bounty/api/[[path]].js`.
- Cloudflare D1 database `mystery-bounty` (binding `MB`), set up from `mystery-bounty/schema.sql`.
- Sign in is by Torn API key. The server checks it with Torn, then gives a signed session token with the role (player, steward or admin). Admins and stewards are allowlists in the database.
- Part of the systoned.cc site. Published with `Publish systoned.cc.command` in the systoned folder.

## Rules
- The Torn key is used for one identity check and never stored.
- Every write checks the session token and its role.
- Money is stored as whole Torn dollars.
- The bounty pool is always worked out from player counts and the bounty settings. It can never be set by hand.
- No build step: plain static files.

## Key files
- `mystery-bounty/index.html`: public player page (stages, tables, seat claims, status search).
- `mystery-bounty/admin.html`: admin tools (roster, donations, settings, stage seating, envelopes, rebuys, reset).
- `mystery-bounty/stewards.html`: steward console for results and knockouts.
- `mystery-bounty/seating-editor.html`: manual seating.
- `mystery-bounty/availability.html` and `availability-admin.html`: player availability poll and its admin view.
- `mystery-bounty/bounty-animation.html`: table replay animation.
- `mystery-bounty/schema.sql`: database tables and seeded admins.
- `functions/mystery-bounty/api/[[path]].js`: server API.
