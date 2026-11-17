// Saves a copy of Maamila's live data on your computer: all ads, the accounts, and every photo.
// Usage (in the Maamila folder):  node tools/backup.mjs
//
// Needs Node.js and the Supabase CLI logged in on this computer (`npx supabase login`, done once).
// Creates backups/<date and time>/ with:
//   ads.json, ads.sql   — every ad (JSON, and SQL INSERTs that can be replayed into the ads table)
//   accounts.json       — sign-in accounts (email, password hash, dates) — private!
//   photos/             — every photo, in the same folders as in the "ad-photos" bucket
//   README.txt          — how to restore
// The folder holds personal data. It is ignored by Git and never published.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The project address comes from the site's own settings (js/config.js), so it is set in one place.
const CONFIG = await fs.readFile(path.join(ROOT, 'js', 'config.js'), 'utf8');
const SUPABASE_URL = (CONFIG.match(/SUPABASE_URL\s*=\s*'([^']+)'/) || [])[1];
const BUCKET = (CONFIG.match(/BUCKET\s*=\s*'([^']+)'/) || [])[1];
if (!SUPABASE_URL || !BUCKET) throw new Error('Could not read SUPABASE_URL / BUCKET from js/config.js');
const PROJECT_REF = new URL(SUPABASE_URL).hostname.split('.')[0];

/** Run a read-only SQL query through the Supabase CLI and return the rows. */
function query(sql) {
  const out = execFileSync(
    'npx',
    ['--yes', 'supabase@2.122.1', 'db', 'query', '--linked', '--project-ref', PROJECT_REF, '--output-format', 'json', sql],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }
  );
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`Supabase CLI gave no data: ${out.slice(0, 300)}`);
  const data = JSON.parse(out.slice(start, out.lastIndexOf('}') + 1));
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.rows ?? [];
}

/** A value written as an SQL literal. */
function literal(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `ARRAY[${value.map(literal).join(', ')}]::text[]`;
  return `'${String(value).replace(/'/g, "''")}'`;
}

const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-');
const dir = path.join(ROOT, 'backups', stamp);

try {
  await fs.mkdir(path.join(dir, 'photos'), { recursive: true, mode: 0o700 });
  console.log(`Backing up the Maamila Supabase project to backups/${stamp}/`);

  const ads = query('select * from public.ads order by created_at');
  await fs.writeFile(path.join(dir, 'ads.json'), JSON.stringify(ads, null, 2), { mode: 0o600 });
  // Columns the database computes itself (e.g. "search") cannot be inserted, so ads.sql leaves them out.
  const generated = new Set(
    query(
      "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'ads' and is_generated = 'ALWAYS'"
    ).map((r) => r.column_name)
  );
  const cols = ads.length ? Object.keys(ads[0]).filter((c) => !generated.has(c)) : [];
  const sql = [
    `-- Maamila ads backup, ${new Date().toISOString()}. Replay into a database set up with supabase/setup.sql`,
    '-- (the accounts referenced by "owner" must exist first).',
    'BEGIN;',
    ...ads.map((a) => `INSERT INTO public.ads (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => literal(a[c])).join(', ')});`),
    'COMMIT;',
    '',
  ];
  await fs.writeFile(path.join(dir, 'ads.sql'), sql.join('\n'), { mode: 0o600 });
  console.log(`  ads        ${ads.length}`);

  const accounts = query(
    'select id, email, phone, encrypted_password, email_confirmed_at, created_at, last_sign_in_at, raw_user_meta_data from auth.users order by created_at'
  );
  await fs.writeFile(path.join(dir, 'accounts.json'), JSON.stringify(accounts, null, 2), { mode: 0o600 });
  console.log(`  accounts   ${accounts.length}`);

  const objects = query(`select name from storage.objects where bucket_id = '${BUCKET}' order by name`);
  const failed = [];
  for (const { name } of objects) {
    try {
      const res = await fetch(`${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${name.split('/').map(encodeURIComponent).join('/')}`);
      if (!res.ok) throw new Error(`download answered ${res.status}`);
      const file = path.join(dir, 'photos', ...name.split('/'));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(await res.arrayBuffer()));
    } catch (err) {
      failed.push(`${name}: ${err.message}`);
    }
  }
  console.log(`  photos     ${objects.length - failed.length} of ${objects.length}`);

  await fs.writeFile(
    path.join(dir, 'README.txt'),
    [
      `Maamila backup made ${new Date().toISOString()}`,
      '',
      'To restore into a new Supabase project:',
      '  1. Run supabase/setup.sql in the SQL editor.',
      '  2. Accounts: accounts.json has each account\'s id, email and password hash. Supabase support or the',
      '     auth admin API can import them so people keep their passwords; otherwise people sign up again.',
      '  3. Ads: run ads.sql in the SQL editor (after the accounts exist, because each ad has an owner).',
      `  4. Photos: upload photos/ to a public bucket "${BUCKET}", keeping the folders.`,
      '     If the project address changed, update the photo addresses in ads.images / ads.thumb.',
      '',
      'This folder contains personal data. Keep it private.',
      '',
    ].join('\n')
  );

  if (failed.length) {
    console.error(`\n! ${failed.length} photo(s) could not be saved:\n  ${failed.join('\n  ')}`);
    process.exitCode = 1;
  } else {
    console.log(`\n✓ Backup saved in backups/${stamp}/`);
  }
} catch (err) {
  console.error(`\n✗ Backup failed: ${err.message}`);
  process.exitCode = 1;
}
