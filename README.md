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
manifest.webmanifest, icons/, sw.js  make the site installable as an app ("Install" / "Add to Home screen")
social/             profile picture, cover banner and link-preview image for social media
worker/index.js     Cloudflare Worker: serves the files, daily keep-awake check, receives email to info@maamila.com
package.json        the Worker's one dependency (postal-mime, reads emails); not published
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
1. Create a Supabase project and run `supabase/setup.sql` in the SQL editor. The file is safe to run again:
   after it changes, run it again on the live project **before** pushing the site code that needs it.
2. In Supabase → Authentication: enable email sign-up, set **Site URL** to your domain and add it to **Redirect URLs**. Users log in with email + password; only logged-in users can post.
   **Confirm email is on.** Account emails (confirmation, password reset) are sent through Brevo
   (Authentication → Emails → SMTP Settings: `smtp-relay.brevo.com`, port 587, sender Maamila <info@maamila.com>).
   In Brevo → Security → Authorized IPs, blocking for **SMTP keys must stay deactivated**, or Supabase's emails fail.
   A Brevo SMTP key stops working after 90 days without any email sent; then generate a new one and paste it in Supabase.
   Mail to info@maamila.com is forwarded by Cloudflare Email Routing.
   **Password reset uses a code, not a link:** Brevo rewrites every link in its emails into a click-tracking link
   (sendibt3.com) that some browsers, ad blockers and VPNs block, and Brevo has no switch to turn that off. So the
   Supabase "Reset password" template shows `{{ .Token }}` (copy in `supabase/email-reset-password.html`) and the site
   asks for that code plus the new password. Sign-up works the same way: the "Confirm sign up" template shows the code
   (copy in `supabase/email-confirm-signup.html`) and the site asks for it right after signing up (or when an
   unconfirmed account tries to log in).
3. Put your project URL and publishable key in `js/config.js`, and the same values in `wrangler.jsonc` (vars) and
   `_headers` (the Content-Security-Policy). `tools/backup.mjs` reads them from `js/config.js`.
4. Deploy the whole folder to any static host (Cloudflare Workers/Pages, Netlify, GitHub Pages).

The publishable key is meant to be public; security is enforced by row-level security policies in `setup.sql`. Never commit the Supabase **secret** key.

## Moderation and limits
Site admins see a **🛡 Admin** link (header and account menu) with the newest 200 ads, and admin buttons on every
ad page: mark as sold or delete (the ad's photos are removed too). The database enforces this: only accounts in the
`admins` table can change other people's ads. Add an admin in the Supabase SQL editor:
```sql
insert into public.admins (user_id) select id from auth.users where email = 'someone@example.com';
```
Remove one with `delete from public.admins where user_id = (select id from auth.users where email = '…');`.
You can also remove an ad in Supabase → Table Editor → `ads` → delete the row.

**Inbox:** email to info@maamila.com goes to the Worker (Cloudflare Email Routing rule "Send to a Worker"), which saves
it in the `messages` table — shown in the admin page's 📥 inbox, with a new-count badge and a "Reply (Gmail)"
button — and forwards a copy to the owner's Gmail. That address is the private Worker secret `FORWARD_TO`
(`npx wrangler secret put FORWARD_TO --name muddy-snow-564c`), never written in this public repository.
Replies are written in the inbox and sent from info@maamila.com by the Worker (POST /api/reply) through Brevo's API;
that needs the Brevo API key as the private Worker secret `BREVO_KEY` (`npx wrangler secret put BREVO_KEY --name muddy-snow-564c`).
The footer's info@maamila.com link opens a new Gmail message in the browser (with a link for other email apps).

**Sample listings:** while the site is new it shows example listings marked «نمونه» (column `ads.sample`), with no
phone or WhatsApp buttons. Only the SQL editor can create them. Delete them on the admin page, or all at once:
`delete from public.ads where sample;`

Built-in limits (in `supabase/setup.sql`): each account can post at most 30 new ads per day and store at most
400 photo files; the post date is always set by the server. Photo addresses must point at our own photo storage.
Also keep the sign-up rate limits in Supabase → Authentication → Rate Limits low, since sign-ups need no email confirmation.

## Supabase library
`index.html` loads one pinned version of supabase-js with an `integrity` hash, and `_headers` allows only that file.
To upgrade, change the version in both files and replace the hash
(`curl -s <file url> | openssl dgst -sha384 -binary | openssl base64 -A`).
