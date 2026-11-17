# Maamila (معامله)

A simple classifieds marketplace for Afghanistan. Factories, shop owners and individuals post products for free; buyers contact sellers directly by phone or WhatsApp.

- Languages: Dari (default), Pashto, Uzbek (Arabic script)
- Plain HTML/CSS/JavaScript — no build step, works on any static host
- Backend: [Supabase](https://supabase.com) (Postgres + photo storage + email/password accounts)
- Hosting: Cloudflare Workers static assets — domain: maamila.com

## Project structure
```
index.html          page shell (loads the files below)
css/style.css       all styles
lang/dr.js          Dari texts + terms & conditions
lang/ps.js          Pashto texts + terms & conditions
lang/uz.js          Uzbek (Arabic script) texts + terms & conditions
js/utils.js         language helpers, number/date formatting
js/data.js          categories, provinces and districts of Afghanistan
js/config.js        Supabase URL and publishable key
js/app.js           app logic: database, pages, posting, filters
supabase/setup.sql  database tables, photo storage and security rules
_headers            security headers for the site (read by Cloudflare, not published)
worker/index.js     Cloudflare Worker: serves the files + daily keep-awake check
tools/backup.mjs    backup command (see Backups)
```
Scripts load in that order as plain `<script>` tags. To preview locally, open `index.html` in a browser or run any static server (e.g. `npx serve .`).

## Deploys
Pushing to `main` deploys automatically to Cloudflare (Workers Builds, worker `muddy-snow-564c`, domain maamila.com). Settings are in `wrangler.jsonc`; files listed in `.assetsignore` are not published.

## Keeping the project awake
Supabase's free plan pauses a project after about a week without activity. The Worker has a daily timer
(06:00 UTC, `triggers` in `wrangler.jsonc`) that reads one ad from the database, so the project never looks idle.
Its runs show in the Cloudflare dashboard → Workers & Pages → muddy-snow-564c → Logs.

## Backups
The free plan has no downloadable backups, so make your own now and then (e.g. weekly):
```bash
node tools/backup.mjs
```
It needs the Supabase CLI logged in on this computer (`npx supabase login`, once) and writes `backups/<date>/`
with the ads (`ads.json`, `ads.sql`), the accounts (`accounts.json`), every photo and a `README.txt` on restoring.
The folder holds personal data: keep it private (it is ignored by Git and never published).

## Setup
1. Create a Supabase project and run `supabase/setup.sql` in the SQL editor.
2. In Supabase → Authentication: enable email sign-up, set **Site URL** to your domain and add it to **Redirect URLs**. Users log in with email + password; only logged-in users can post.
   **Confirm email is turned off** (since 17 Nov 2026): Supabase's built-in email sender barely delivers to normal
   users on the free plan, so nobody could finish signing up. To turn it back on, first connect your own email
   service (Authentication → Emails → SMTP settings, e.g. Brevo or Resend); password-reset emails need it too.
3. Put your project URL and publishable key in `js/config.js`.
4. Deploy the whole folder to any static host (Cloudflare Workers/Pages, Netlify, GitHub Pages).

The publishable key is meant to be public; security is enforced by row-level security policies in `setup.sql`. Never commit the Supabase **secret** key.

## Moderation
Remove an ad in Supabase → Table Editor → `ads` → delete the row.
