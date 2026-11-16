# Maamila (معامله)

A simple classifieds marketplace for Afghanistan. Factories, shop owners and individuals post products for free; buyers contact sellers directly by phone or WhatsApp.

- Languages: Dari (default), Pashto, Uzbek (Arabic script)
- Plain HTML/CSS/JavaScript — no build step, works on any static host
- Backend: [Supabase](https://supabase.com) (Postgres + photo storage + anonymous sign-in)
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
```
Scripts load in that order as plain `<script>` tags. To preview locally, open `index.html` in a browser or run any static server (e.g. `npx serve .`).

## Deploys
Pushing to `main` deploys automatically to Cloudflare (Workers Builds, worker `muddy-snow-564c`, domain maamila.com). Settings are in `wrangler.jsonc`; files listed in `.assetsignore` are not published.

## Setup
1. Create a Supabase project and run `supabase/setup.sql` in the SQL editor.
2. In Supabase → Authentication → Sign In / Providers, enable **Allow anonymous sign-ins**.
3. Put your project URL and publishable key in `js/config.js`.
4. Deploy the whole folder to any static host (Cloudflare Workers/Pages, Netlify, GitHub Pages).

The publishable key is meant to be public; security is enforced by row-level security policies in `setup.sql`. Never commit the Supabase **secret** key.

## Moderation
Remove an ad in Supabase → Table Editor → `ads` → delete the row.
