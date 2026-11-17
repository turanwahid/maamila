// Cloudflare Worker for maamila.com (settings: wrangler.jsonc).
// - Visitors: the site's files are served directly by Cloudflare.
// - Once a day (the "crons" trigger): reads one ad from Supabase. That is a real database query, so
//   Supabase sees activity — its free plan pauses projects that have none for about a week.
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
};
