// Cloudflare Worker for maamila.com (settings: wrangler.jsonc).
// - Visitors: the site's files are served directly by Cloudflare.
// - Once a day (the "crons" trigger): reads one ad from Supabase. That is a real database query, so
//   Supabase sees activity — its free plan pauses projects that have none for about a week.
// - Email to info@maamila.com (Cloudflare Email Routing rule "Send to a Worker"): saved in the messages table,
//   where it shows in the admin page's inbox, and a copy is forwarded to the owner's Gmail (FORWARD_TO, a
//   private Worker secret, never in this public repository).
// - POST /api/reply (from the admin inbox): sends the admin's reply from info@maamila.com through Brevo's API
//   (BREVO_KEY, a private Worker secret) and stores it on the message. Only admins: the message is read with the
//   visitor's own login, and the database only shows messages to admins.
import PostalMime from 'postal-mime';

/** Plain text of an email: the text part, or the HTML part without tags. */
function textOf(mail) {
  if (mail.text && mail.text.trim()) return mail.text.trim();
  return (mail.html || '')
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

/** Reads the email and saves sender, name, subject and text in the messages table (the admin inbox). */
async function saveToInbox(message, env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) throw new Error('SUPABASE_URL / SUPABASE_KEY are missing in the Worker settings.');
  const mail = await PostalMime.parse(await new Response(message.raw).arrayBuffer());
  const from = ((mail.from && mail.from.address) || message.from || '').trim().toLowerCase();
  const name = ((mail.from && mail.from.name) || '').trim();
  const subject = (mail.subject || '').trim();
  const body = ([subject, textOf(mail)].filter(Boolean).join('\n\n') || '(empty email)').slice(0, 2000).padEnd(5, ' ');
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/messages`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_KEY, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ name: name.slice(0, 60), contact: from.slice(0, 100), body }),
  });
  if (!res.ok) throw new Error(`Supabase answered ${res.status}: ${await res.text()}`);
  console.log(`Email from ${from} saved to the admin inbox.`);
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const escHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** POST /api/reply {id, text}: an admin replies to an inbox email; sent from info@maamila.com via Brevo. */
async function sendReply(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!/^Bearer \S+$/.test(auth)) return json({ error: 'login required' }, 401);
  let id, text;
  try {
    ({ id, text } = await request.json());
  } catch (e) {
    return json({ error: 'bad request' }, 400);
  }
  text = String(text || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(String(id)) || text.length < 2 || text.length > 5000) return json({ error: 'bad request' }, 400);
  const db = (path, init = {}) =>
    fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: env.SUPABASE_KEY, Authorization: auth, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
  // Read the message as the logged-in visitor: the database returns it only to admins.
  const r = await db(`messages?id=eq.${id}&select=name,contact,body`);
  const rows = r.ok ? await r.json() : [];
  if (!rows.length) return json({ error: 'not allowed' }, 403);
  const m = rows[0];
  const to = String(m.contact).trim();
  if (!/^[^@\s"<>]+@[^@\s"<>]+\.[^@\s"<>]+$/.test(to)) return json({ error: 'no email address' }, 400);
  if (!env.BREVO_KEY) return json({ error: 'BREVO_KEY is not set on the Worker' }, 500);
  const firstLine = (m.body.split('\n')[0] || '').trim().slice(0, 120);
  const subject = /^re:/i.test(firstLine) ? firstLine : `Re: ${firstLine || 'Maamila'}`;
  const quoted = m.body.split('\n').map((l) => '> ' + l).join('\n');
  const sent = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: 'Maamila', email: 'info@maamila.com' },
      replyTo: { email: 'info@maamila.com', name: 'Maamila' },
      to: [m.name ? { email: to, name: m.name.slice(0, 60) } : { email: to }],
      subject,
      textContent: `${text}\n\n—\nMaamila · maamila.com\n\n${quoted}`,
      htmlContent: `<div dir="auto" style="font-family:Tahoma,Arial,sans-serif;line-height:1.7;white-space:pre-line">${escHtml(text)}</div>
<p style="color:#6b7280;font-size:13px">— Maamila · maamila.com</p>
<blockquote style="border-inline-start:3px solid #e5e7eb;margin:0;padding:0 12px;color:#6b7280;white-space:pre-line">${escHtml(m.body)}</blockquote>`,
    }),
  });
  if (!sent.ok) {
    const detail = await sent.text();
    console.error(`Brevo refused the reply: ${sent.status} ${detail}`);
    return json({ error: 'sending failed', status: sent.status }, 502);
  }
  // Store the reply on the message (again as the admin, so the database checks it).
  const u = await db(`messages?id=eq.${id}`, {
    method: 'PATCH',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({ reply: text, replied_at: new Date().toISOString(), handled: true }),
  });
  if (!u.ok) console.error(`Reply sent but not stored: ${u.status} ${await u.text()}`);
  console.log(`Reply sent to ${to}.`);
  return json({ ok: true });
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/reply') {
      if (request.method !== 'POST') return json({ error: 'use POST' }, 405);
      return sendReply(request, env);
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      fetch(`${env.SUPABASE_URL}/rest/v1/ads?select=id&limit=1`, { headers: { apikey: env.SUPABASE_KEY } }).then((res) => {
        if (!res.ok) throw new Error(`Keep-awake check: Supabase answered ${res.status}`);
        console.log('Keep-awake check: Supabase answered.');
      })
    );
  },

  async email(message, env) {
    console.log(`Email received for ${message.to}, ${message.rawSize} bytes.`);
    // Save first, forward last: forward() sends the original message, so the save never waits on it.
    try {
      await saveToInbox(message, env);
    } catch (err) {
      console.error('Saving the email to the admin inbox failed:', err);
    }
    // A copy in Gmail, so nothing is lost even if saving failed.
    if (env.FORWARD_TO) {
      try {
        await message.forward(env.FORWARD_TO);
        console.log('Copy forwarded to Gmail.');
      } catch (err) {
        console.error('Forwarding to Gmail failed:', err);
      }
    }
  },
};
