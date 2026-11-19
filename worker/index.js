// Cloudflare Worker for maamila.com (settings: wrangler.jsonc).
// - Visitors: the site's files are served directly by Cloudflare.
// - Once a day (the "crons" trigger): reads one ad from Supabase. That is a real database query, so
//   Supabase sees activity — its free plan pauses projects that have none for about a week.
// - Email to info@maamila.com (Cloudflare Email Routing rule "Send to a Worker"): saved in the messages table,
//   where it shows in the admin page's inbox, and a copy is forwarded to the owner's Gmail (FORWARD_TO, a
//   private Worker secret, never in this public repository).
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

export default {
  fetch(request, env) {
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
