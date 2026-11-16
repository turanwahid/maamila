# Maamila (معامله)

A simple classifieds marketplace for Afghanistan. Factories, shop owners and individuals post products for free; buyers contact sellers directly by phone or WhatsApp.

- Languages: Dari (default), Pashto, Uzbek (Arabic script)
- Single-file site: `index.html` (no build step)
- Backend: [Supabase](https://supabase.com) (Postgres + photo storage + anonymous sign-in)
- Hosting: Cloudflare Workers static assets — domains: maamila.com, barzarcha.com

## Setup
1. Create a Supabase project and run `supabase/setup.sql` in the SQL editor.
2. In Supabase → Authentication → Sign In / Providers, enable **Allow anonymous sign-ins**.
3. Put your project URL and publishable key in `index.html` (`SUPABASE_URL`, `SUPABASE_KEY`).
4. Upload `index.html` to Cloudflare (Workers & Pages → Upload static files).

The publishable key is meant to be public; security is enforced by row-level security policies in `setup.sql`. Never commit the Supabase **secret** key.

## Moderation
Remove an ad in Supabase → Table Editor → `ads` → delete the row.
