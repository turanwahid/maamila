'use strict';
/* ===== state & storage ===== */
const LS = {
  get(k, d) {
    try {
      const v = localStorage.getItem('bzk:' + k);
      return v ? JSON.parse(v) : d;
    } catch (e) {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('bzk:' + k, JSON.stringify(v));
    } catch (e) {}
  },
};
const st = {
  sb: null,
  dbErr: false,
  uid: null,
  isAdmin: false, // true for site admins (public.admins); null while being checked
  adminAds: null, // newest ads for the admin page
  // home list: one page at a time from the server, for the current filters
  list: [],
  total: 0,
  more: false,
  listKey: '', // filters the list was loaded for
  loadingKey: '',
  listErr: '',
  listStale: false,
  byId: new Map(), // id -> full ad (with description + photos), or null when it does not exist
  rel: new Map(), // id -> { more, sim } ads shown under an ad
  mine: null, // { uid, ads }
  savedAds: null, // { key, ads }
  err: new Set(), // keys of loads that failed (cleared by "try again")
  me: Object.assign({ saved: [], name: '', phone: '', wa: true, city: '' }, LS.get('me', {})),
  city: LS.get('city', 'all'),
  district: '',
  cat: 'all',
  stype: 'all',
  sort: 'new',
  q: '',
  draft: null,
};
const PAGE = 48;
const LIST_COLS =
  'id,created_at,owner,title,cat,price,stype,sale,city,district,name,phone,wa,thumb,sold';
const COLS = LIST_COLS + ',descr,images';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PHOTO_PREFIX = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/`;
/** Only addresses of photos in our own storage are shown (anything else in the database is ignored). */
const isPhotoUrl = (u) =>
  typeof u === 'string' &&
  u.startsWith(PHOTO_PREFIX) &&
  /^[A-Za-z0-9_./-]+$/.test(u.slice(PHOTO_PREFIX.length)) &&
  !u.includes('..');
const fromRow = (r) => {
  const images = (r.images || []).filter(isPhotoUrl);
  return {
    id: r.id,
    at: Date.parse(r.created_at),
    owner: r.owner,
    title: r.title,
    cat: r.cat,
    price: Number(r.price) || 0,
    stype: r.stype,
    sale: r.sale,
    city: r.city,
    district: r.district || '',
    desc: r.descr || '',
    name: r.name,
    phone: r.phone,
    wa: !!r.wa,
    images,
    thumb: isPhotoUrl(r.thumb) ? r.thumb : '',
    sold: !!r.sold,
    icon: catById(r.cat).i,
  };
};
function saveMe() {
  LS.set('me', st.me);
}
// What the address said when the page opened: after an email link (password reset, sign-up confirmation)
// Supabase sends the visitor back with the result here, e.g. #access_token=…&type=recovery or #error_code=otp_expired.
const START_HASH = new URLSearchParams(location.hash.replace(/^#/, ''));
/** Reacts to the result of an email link, then removes it from the address bar. */
function handleEmailLink() {
  const err = START_HASH.get('error_code') || START_HASH.get('error');
  const fromLink = err || START_HASH.has('access_token');
  if (!fromLink) return;
  history.replaceState(null, '', location.pathname + location.search); // tokens should not stay in the address
  if (err) {
    toast(t('link_expired'), 1);
    openAuth(START_HASH.get('type') === 'signup' ? 'login' : 'forgot');
  } else if (START_HASH.get('type') === 'recovery') {
    if (st.uid) openAuth('newpw');
    else {
      toast(t('link_expired'), 1); // the link could not log the visitor in
      openAuth('forgot');
    }
  }
  route(true);
}
async function initDb() {
  if (!window.supabase) {
    st.dbErr = true;
    route(true);
    return;
  }
  st.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  // Listen before reading the session, so the "password recovery" event from a reset link is not missed.
  st.sb.auth.onAuthStateChange((ev, session) => {
    const before = st.uid;
    setUser(session ? session.user : null);
    // Supabase advises against doing more work inside this callback, so continue right after it.
    setTimeout(() => {
      if (ev === 'PASSWORD_RECOVERY') openAuth('newpw');
      if (st.uid === before) return;
      checkAdmin();
      renderChrome();
      if (!document.getElementById('postform') && !document.getElementById('authform')) route(true);
    }, 0);
  });
  try {
    const { data } = await st.sb.auth.getSession();
    setUser(data && data.session ? data.session.user : null);
  } catch (e) {}
  checkAdmin();
  route(true);
  handleEmailLink();
  setInterval(() => {
    if (cur() === 'home' && !document.hidden && st.listKey === filterKey()) loadList(true);
  }, 60000);
}

/** Asks the database whether the logged-in account is a site admin (it also enforces this itself). */
let adminFor;
async function checkAdmin() {
  const uid = st.uid;
  if (adminFor === uid) return;
  adminFor = uid;
  st.adminAds = null;
  st.isAdmin = uid ? null : false;
  if (!uid || !st.sb) return;
  const { data, error } = await st.sb.rpc('is_admin');
  if (st.uid !== uid) return;
  st.isAdmin = !error && data === true;
  renderChrome();
  soft();
}

/* ===== loading ads ===== */
const searchWords = (q) =>
  norm(q)
    .split(' ')
    .map((w) => w.replace(/[^\p{L}\p{M}\p{N}]/gu, ''))
    .filter(Boolean)
    .slice(0, 6);
const filterKey = () =>
  JSON.stringify([st.city, st.city === 'all' ? '' : st.district, st.cat, st.stype, st.sort, searchWords(st.q)]);
function listQuery(cols, count) {
  let q = st.sb.from('ads').select(cols, count ? { count: 'exact' } : undefined);
  if (st.city !== 'all') {
    q = q.eq('city', st.city);
    if (st.district) q = q.eq('district', st.district);
  }
  if (st.cat !== 'all') q = q.eq('cat', st.cat);
  if (st.stype === 'wholesale') q = q.neq('sale', 'retail');
  else if (st.stype !== 'all') q = q.eq('stype', st.stype);
  // every word must match: the text of the ad, or a category / province name (in any language)
  for (const w of searchWords(st.q)) {
    const cats = CATS.filter((c) => Object.values(c.n).some((n) => norm(n).includes(w))).map((c) => c.id);
    const provs = PROVS.filter((p) => Object.values(p[1]).some((n) => norm(n).includes(w))).map((p) => p[0]);
    const alts = [`search.ilike.*${w}*`];
    if (cats.length) alts.push(`cat.in.(${cats.join(',')})`);
    if (provs.length) alts.push(`city.in.(${provs.join(',')})`);
    q = alts.length > 1 ? q.or(alts.join(',')) : q.ilike('search', `%${w}%`);
  }
  q = q.order('sold', { ascending: true });
  if (st.sort === 'cheap') q = q.order('price_n', { ascending: true, nullsFirst: false });
  else if (st.sort === 'exp') q = q.order('price', { ascending: false });
  return q.order('created_at', { ascending: false }).order('id', { ascending: true });
}
let listSeq = 0;
/** Loads the first page for the current filters (keep: also reload the extra pages already shown). */
async function loadList(keep) {
  if (!st.sb) return;
  const key = filterKey();
  keep = keep && st.listKey === key;
  st.loadingKey = key;
  const n = keep ? Math.min(Math.max(PAGE, st.list.length), 480) : PAGE;
  const seq = ++listSeq;
  const { data, error, count } = await listQuery(LIST_COLS, true).range(0, n - 1);
  if (seq !== listSeq) return; // filters changed meanwhile; a newer load is running
  st.loadingKey = '';
  if (error) {
    console.error(error);
    if (!keep) st.listErr = key;
  } else {
    st.list = data.map(fromRow);
    st.total = count ?? st.list.length;
    st.more = st.list.length < st.total;
    st.listKey = key;
    st.listErr = '';
    st.listStale = false;
  }
  if (cur() === 'home') soft();
}
function ensureList() {
  const key = filterKey();
  if (!st.sb || st.loadingKey === key || st.listErr === key) return;
  if (st.listKey === key && !st.listStale) return;
  loadList(st.listKey === key);
}
async function loadMore(btn) {
  const key = filterKey();
  if (st.listKey !== key) return;
  btn.disabled = true;
  const seq = ++listSeq;
  const { data, error } = await listQuery(LIST_COLS).range(st.list.length, st.list.length + PAGE - 1);
  if (seq !== listSeq) return;
  if (error) {
    btn.disabled = false;
    return toast(t('load_err'), 1);
  }
  const seen = new Set(st.list.map((x) => x.id));
  st.list.push(...data.map(fromRow).filter((x) => !seen.has(x.id)));
  st.more = data.length === PAGE && st.list.length < st.total;
  route(true);
}
const pending = new Set();
/** Runs a load once; when it finishes the page is drawn again (if the visitor is still on it). */
function fetchOnce(key, fn) {
  if (!st.sb || pending.has(key) || st.err.has(key)) return;
  pending.add(key);
  const at = cur();
  fn()
    .catch((e) => {
      console.error(e);
      st.err.add(key);
    })
    .finally(() => {
      pending.delete(key);
      if (cur() === at) soft();
    });
}
/** The full ad, undefined while it loads, null if it does not exist. */
function getAd(id) {
  if (!UUID_RE.test(id)) return null;
  if (st.byId.has(id)) return st.byId.get(id);
  fetchOnce('ad:' + id, async () => {
    const { data, error } = await st.sb.from('ads').select(COLS).eq('id', id).maybeSingle();
    if (error) throw error;
    st.byId.set(id, data ? fromRow(data) : null);
  });
}
function getRel(a) {
  if (st.rel.has(a.id)) return st.rel.get(a.id);
  fetchOnce('rel:' + a.id, async () => {
    const [m, s] = await Promise.all([
      st.sb.from('ads').select(LIST_COLS).eq('phone', a.phone).neq('id', a.id)
        .order('created_at', { ascending: false }).limit(4),
      st.sb.from('ads').select(LIST_COLS).eq('cat', a.cat).neq('phone', a.phone).neq('id', a.id)
        .order('sold', { ascending: true }).order('created_at', { ascending: false }).limit(8),
    ]);
    if (m.error || s.error) throw m.error || s.error;
    st.rel.set(a.id, { more: m.data.map(fromRow), sim: s.data.map(fromRow) });
  });
  return { more: [], sim: [] };
}
function getAdminAds() {
  if (st.adminAds) return st.adminAds;
  fetchOnce('admin', async () => {
    const { data, error } = await st.sb.from('ads').select(LIST_COLS)
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    st.adminAds = data.map(fromRow);
  });
}
/** Any copy of an ad kept in memory. */
const findAd = (id) => st.byId.get(id) || adLists().flat().find((x) => x.id === id);
function getMine() {
  if (st.mine && st.mine.uid === st.uid) return st.mine.ads;
  const uid = st.uid;
  fetchOnce('mine:' + uid, async () => {
    const { data, error } = await st.sb.from('ads').select(COLS).eq('owner', uid)
      .order('created_at', { ascending: false }).limit(1000);
    if (error) throw error;
    const ads = data.map(fromRow);
    ads.forEach((a) => st.byId.set(a.id, a));
    st.mine = { uid, ads };
  });
}
const savedIds = () => st.me.saved.filter((id) => UUID_RE.test(id)).slice(-200);
function getSaved() {
  const ids = savedIds();
  const key = ids.join(',');
  if (!ids.length) return [];
  if (st.savedAds && st.savedAds.key === key) return st.savedAds.ads;
  fetchOnce('saved:' + key, async () => {
    const { data, error } = await st.sb.from('ads').select(LIST_COLS).in('id', ids);
    if (error) throw error;
    const m = new Map(data.map((r) => [r.id, fromRow(r)]));
    st.savedAds = { key, ads: ids.map((id) => m.get(id)).filter(Boolean) };
  });
}
/** Every copy of an ad that is kept in memory (lists, single ads). */
const adLists = () =>
  [st.list, st.mine && st.mine.ads, st.savedAds && st.savedAds.ads, st.adminAds, ...[...st.rel.values()].flatMap((r) => [r.more, r.sim])].filter(Boolean);
function patchAd(id, fields) {
  for (const l of adLists()) for (const x of l) if (x.id === id) Object.assign(x, fields);
  const b = st.byId.get(id);
  if (b) Object.assign(b, fields);
}
function removeAd(id) {
  for (const l of adLists()) for (let i = l.length - 1; i >= 0; i--) if (l[i].id === id) l.splice(i, 1);
  st.byId.set(id, null);
  st.total = Math.max(0, st.total - 1);
}

/* ===== accounts (email + password) ===== */
function setUser(u) {
  const real = u && !u.is_anonymous;
  st.uid = real ? u.id : null;
  st.email = real ? u.email || '' : '';
}
const LOGIN_REQUIRED = 'login required';
async function ensureUser() {
  if (st.uid) return st.uid;
  openAuth('login');
  throw new Error(LOGIN_REQUIRED);
}
function openAuth(mode, email = '') {
  const f = (name, type, ph, extra = '') =>
    `<div class="fld"><label>${t(name)}</label><input name="${name}" type="${type}" dir="ltr" autocomplete="${extra}" style="text-align:start" placeholder="${ph}"></div>`;
  const body = {
    login: `${f('email', 'email', 'name@example.com', 'email')}${f('password', 'password', '••••••', 'current-password')}
      <button class="btn p blk">${t('login')}</button>
      <div class="authlinks"><a href="#" data-act="auth" data-m="forgot">${t('forgot')}</a><span>${t('no_account')} <a href="#" data-act="auth" data-m="signup">${t('signup')}</a></span></div>`,
    signup: `${f('email', 'email', 'name@example.com', 'email')}${f('password', 'password', '••••••', 'new-password')}
      <button class="btn p blk">${t('signup')}</button>
      <p class="faint" style="font-size:12.5px;text-align:center;margin:10px 0 0">${t('agree', `<a href="#terms" data-act="mclose" style="color:var(--blue)">${t('terms')}</a>`)}</p>
      <div class="authlinks"><span>${t('have_account')} <a href="#" data-act="auth" data-m="login">${t('login')}</a></span></div>`,
    forgot: `${f('email', 'email', 'name@example.com', 'email')}<button class="btn p blk">${t('send_code')}</button>
      <div class="authlinks"><a href="#" data-act="auth" data-m="login">${t('login')}</a></div>`,
    // password reset with the code from the email (links in emails pass through Brevo's click tracking,
    // which some browsers, ad blockers and VPNs block)
    code: `<p class="muted" dir="ltr" style="text-align:center;margin:0 0 12px">${esc(email)}</p>
      <div class="fld"><label>${t('code_label')}</label><input name="code" inputmode="numeric" autocomplete="one-time-code" dir="ltr" maxlength="12" style="text-align:center;letter-spacing:6px;font-size:20px" placeholder="••••••"></div>
      ${f('password', 'password', '••••••', 'new-password').replace(t('password'), t('new_password'))}
      <button class="btn p blk">${t('save')}</button>
      <div class="authlinks"><a href="#" data-act="auth" data-m="forgot">${t('resend')}</a></div>`,
    newpw: `${f('password', 'password', '••••••', 'new-password').replace(t('password'), t('new_password'))}<button class="btn p blk">${t('save')}</button>`,
    // confirm a new account with the code from the email (same reason as above: no links in emails)
    verify: `<p class="muted" dir="ltr" style="text-align:center;margin:0 0 12px">${esc(email)}</p>
      <div class="fld"><label>${t('code_label')}</label><input name="code" inputmode="numeric" autocomplete="one-time-code" dir="ltr" maxlength="12" style="text-align:center;letter-spacing:6px;font-size:20px" placeholder="••••••"></div>
      <button class="btn p blk">${t('confirm')}</button>
      <div class="authlinks"><a href="#" data-act="resend">${t('resend')}</a></div>`,
  }[mode];
  const title = {
    login: t('login_t'),
    signup: t('signup_t'),
    forgot: t('forgot_t'),
    code: t('forgot_t'),
    verify: t('verify_t'),
    newpw: t('new_password'),
  }[mode];
  modal(`<h3>🔑 ${title}</h3><form id="authform" data-mode="${mode}" data-email="${esc(email)}" novalidate>${body}</form>`);
  setTimeout(() => document.querySelector('#authform input')?.focus(), 50);
}
async function submitAuth(f) {
  const mode = f.dataset.mode;
  const email = (f.elements.email ? f.elements.email.value : f.dataset.email || '').trim().toLowerCase();
  const pw = f.elements.password?.value || '';
  const code = latinDigits(f.elements.code?.value || '').replace(/\D/g, '');
  if (mode !== 'newpw' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast(t('bad_email'), 1);
  if ((mode === 'code' || mode === 'verify') && code.length < 6) return toast(t('code_bad'), 1);
  if (mode !== 'forgot' && mode !== 'verify' && pw.length < 6) return toast(t('pw_short'), 1);
  const btn = f.querySelector('button.p');
  btn.disabled = true;
  try {
    if (mode === 'login') {
      const { error } = await st.sb.auth.signInWithPassword({ email, password: pw });
      if (error && error.code === 'email_not_confirmed') {
        await st.sb.auth.resend({ type: 'signup', email });
        openAuth('verify', email);
        toast(t('verify_sent'));
        return;
      }
      if (error) throw error;
      modal('');
      toast(t('welcome'));
    } else if (mode === 'signup') {
      const { data, error } = await st.sb.auth.signUp({
        email,
        password: pw,
        options: { emailRedirectTo: location.origin },
      });
      if (error) throw error;
      if (data.user && data.user.identities && !data.user.identities.length)
        throw { code: 'user_already_exists' };
      if (!data.session) {
        openAuth('verify', email);
        toast(t('verify_sent'));
        return;
      }
      modal('');
      toast(t('signup_ok'));
    } else if (mode === 'verify') {
      const { error } = await st.sb.auth.verifyOtp({ email, token: code, type: 'signup' });
      if (error) throw { code: 'otp_bad' };
      modal('');
      toast(t('signup_ok'));
    } else if (mode === 'forgot') {
      const { error } = await st.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin });
      if (error) throw error;
      openAuth('code', email);
      toast(t('code_sent'));
      return;
    } else if (mode === 'code') {
      const { error } = await st.sb.auth.verifyOtp({ email, token: code, type: 'recovery' });
      if (error) throw { code: 'otp_bad' };
      const { error: e2 } = await st.sb.auth.updateUser({ password: pw });
      if (e2) {
        openAuth('newpw'); // the code was right and the visitor is logged in; only the new password failed
        throw e2;
      }
      modal('');
      toast(t('pw_changed'));
    } else if (mode === 'newpw') {
      const { error } = await st.sb.auth.updateUser({ password: pw });
      if (error) throw error;
      modal('');
      toast(t('pw_changed'));
    }
    renderChrome();
    route(true);
  } catch (e) {
    const code = (e && (e.code || e.message)) || '';
    toast(
      code === 'otp_bad'
        ? t('code_bad')
        : /same_password|different from the old/i.test(code)
          ? t('pw_same')
          : /already|exists|registered/i.test(code)
        ? t('email_taken')
        : /invalid|credentials/i.test(code)
          ? t('auth_err')
          : /weak|short/i.test(code)
            ? t('pw_short')
            : t('save_err'),
      1,
    );
    btn.disabled = false;
  }
}
function openAccount() {
  modal(`<h3>👤 ${t('account')}</h3><p class="muted" dir="ltr" style="text-align:start;margin:0 0 14px">${esc(st.email)}</p>
    <div class="clist"><button data-act="go" data-h="mine">📋 ${t('my_ads')}</button><button data-act="go" data-h="saved">♡ ${t('saved')}</button><button data-act="go" data-h="post">＋ ${t('post')}</button>${st.isAdmin ? `<button data-act="go" data-h="admin">🛡 ${t('admin')}</button>` : ''}</div>
    <button class="btn d blk" style="margin-top:14px" data-act="logout">↩ ${t('logout')}</button>`);
}
function loginPrompt(msg) {
  return `<div class="empty" style="margin-top:16px"><div class="e">🔑</div><p>${msg}</p>
    <div class="row" style="justify-content:center;flex-wrap:wrap"><button class="btn p" data-act="auth" data-m="login">${t('login')}</button><button class="btn" data-act="auth" data-m="signup">${t('signup')}</button></div></div>`;
}
function dataUrlToBlob(u) {
  const [h, b] = u.split(',');
  const bin = atob(b);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (h.match(/:(.*?);/) || [])[1] || 'image/jpeg' });
}
async function upload(path, dataUrl) {
  const { error } = await st.sb.storage.from(BUCKET).upload(path, dataUrlToBlob(dataUrl), {
    contentType: 'image/jpeg',
    upsert: true,
    cacheControl: '31536000',
  });
  if (error) throw error;
  return st.sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}
async function saveAd(id, ad, imgs, isNew) {
  const uid = await ensureUser();
  const v = Date.now().toString(36);
  const urls = [];
  for (let i = 0; i < imgs.length; i++) {
    const im = imgs[i];
    urls.push(im.startsWith('data:') ? await upload(`${uid}/${id}/${v}-${i}.jpg`, im) : im);
  }
  let thumb = ad.thumbData
    ? await upload(`${uid}/${id}/${v}-t.jpg`, ad.thumbData)
    : urls.length
      ? ad.thumb || ''
      : '';
  if (!urls.length) thumb = '';
  const row = {
    id,
    title: ad.title,
    cat: ad.cat,
    price: ad.price,
    stype: ad.stype,
    sale: ad.sale,
    city: ad.city,
    district: ad.district || '',
    descr: ad.desc,
    name: ad.name,
    phone: ad.phone,
    wa: ad.wa,
    images: urls,
    thumb,
    sold: !!ad.sold,
  };
  const q = isNew
    ? st.sb
        .from('ads')
        .insert({ ...row, owner: uid })
        .select(COLS)
        .single()
    : st.sb.from('ads').update(row).eq('id', id).select(COLS).single();
  const { data, error } = await q;
  if (error) throw error;
  const a = fromRow(data);
  if (st.byId.get(id)) patchAd(id, a);
  else if (st.mine && st.mine.uid === uid) st.mine.ads.unshift(a);
  st.byId.set(id, a);
  st.listStale = true; // the home list reloads (in the background) the next time it is shown
  st.rel.clear();
  cleanupPhotos(uid, id, [...urls, thumb]);
  return a;
}
async function cleanupPhotos(uid, id, keep) {
  try {
    const { data } = await st.sb.storage.from(BUCKET).list(`${uid}/${id}`);
    if (!data) return;
    const rm = data.map((f) => `${uid}/${id}/${f.name}`).filter((p) => !keep.some((u) => u && u.endsWith(p)));
    if (rm.length) await st.sb.storage.from(BUCKET).remove(rm);
  } catch (e) {}
}
async function setSold(ad, sold) {
  const { data, error } = await st.sb.from('ads').update({ sold }).eq('id', ad.id).select('id');
  if (error || !data.length) {
    toast(t('save_err'), 1);
    throw error;
  }
  patchAd(ad.id, { sold });
}
async function delAd(id) {
  const owner = (findAd(id) || {}).owner;
  const { data, error } = await st.sb.from('ads').delete().eq('id', id).select('id');
  if (error || !data.length) {
    toast(t('save_err'), 1);
    throw error || new Error('not allowed');
  }
  removeAd(id);
  if (owner) cleanupPhotos(owner, id, []); // photos live in the owner's folder (an admin may delete others' ads)
}
/** Draws the page again after new data arrived (not while a post form is open, so nothing typed is lost). */
let sT = null;
function soft() {
  clearTimeout(sT);
  sT = setTimeout(() => {
    if (document.getElementById('postform')) return;
    route(true);
  }, 100);
}

/* ===== helpers ===== */
const loadingBox = () => (st.dbErr ? errBox() : `<div class="empty"><div class="e">⏳</div></div>`);
const errBox = () =>
  `<div class="empty"><div class="e">⚠️</div><p>${t('load_err')}</p><button class="btn p" data-act="retry">↻ ${t('retry')}</button></div>`;
const hueOf = (a) => (catById(a.cat).h + (hashH(a.id) % 30)) % 360;
const priceHtml = (a, big) =>
  a.price
    ? `${num(a.price)} <small>${t('cur')}</small>`
    : `<span style="font-size:${big ? 18 : 14}px;color:var(--blue)">${t('negotiable')}</span>`;
const stTag = (a) => {
  const [i, c] = STYPE[a.stype] || STYPE.person;
  return `<span class="tag ${c}">${i} ${t(a.stype)}</span>`;
};
const saleTag = (a) =>
  a.sale === 'wholesale'
    ? `<span class="tag w">${t('wholesale')}</span>`
    : a.sale === 'both'
      ? `<span class="tag w">${t('both')}</span>`
      : '';
const soldBtn = (a) =>
  `<button class="btn sm" data-act="sold" data-id="${a.id}">${a.sold ? '↺ ' + t('relist') : '✓ ' + t('mark_sold')}</button>`;
const delBtn = (a) => `<button class="btn sm d" data-act="del" data-id="${a.id}">${t('del')}</button>`;
function photo(a, extra = '') {
  return `<div class="ph" style="--h:${hueOf(a)}" ${extra}><span>${a.icon || catById(a.cat).i}</span>${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy">` : ''}</div>`;
}
function adCard(a) {
  const sv = st.me.saved.includes(a.id);
  return `<a class="ad" href="#ad-${a.id}"><div style="position:relative">${photo(a)}
    <div class="ph-tags" style="position:absolute;top:8px;inset-inline-start:8px;display:flex;gap:4px;flex-wrap:wrap;max-width:75%">${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}${stTag(a)}${saleTag(a)}</div>
    <button class="heart ${sv ? 'on' : ''}" data-act="save" data-id="${a.id}" aria-label="${t('saved')}">${sv ? '♥' : '♡'}</button>
    </div>
    <div class="bd"><div class="tt">${esc(a.title)}</div><div class="pr">${priceHtml(a)}</div><div class="mt">📍 ${esc(placeName(a))} · ${ago(a.at)}</div></div></a>`;
}
function toast(m, err) {
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' err' : '');
  d.textContent = m;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => d.remove(), Math.max(2800, String(m).length * 70)); // longer messages stay longer
}
function modal(h) {
  document.getElementById('modal').innerHTML = h
    ? `<div class="mbg" data-act="mclose"><div class="mdl">${h}</div></div>`
    : '';
}
const LOGO = `<svg viewBox="0 0 40 40" aria-hidden="true"><rect width="40" height="40" rx="12" fill="#1a56db"/><path d="M8 15.5 11 9h18l3 6.5z" fill="#fff"/><path d="M8 15.5h24v2a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z" fill="#f59e0b"/><path d="M10 20.5h20V31H10z" fill="#fff"/><path d="M17.5 31v-6h5v6z" fill="#1a56db"/></svg>`;
function waNum(p) {
  let d = latinDigits(p).replace(/\D/g, '');
  if (d.startsWith('0')) d = '93' + d.slice(1);
  else if (!d.startsWith('93')) d = '93' + d;
  return d;
}

/* ===== chrome ===== */
function renderChrome() {
  const li = LANGS.find((l) => l[0] === LANG);
  document.documentElement.lang = LANG === 'dr' ? 'fa-AF' : li[2];
  document.title = `${t('brand')} — ${t('hero')}`;
  const r = cur();
  const cityLabel = st.city === 'all' ? t('all_af') : cityName(st.city);
  document.getElementById('hdr').innerHTML = `<a class="logo" href="#home" data-act="home">${LOGO}${t('brand')}</a>
    <button class="pill cityp" data-act="city">📍 <span class="tx">${esc(cityLabel)}</span> ▾</button>
    <span class="sp"></span>
    <nav class="dnav"><a class="pill" href="#saved">♡ ${t('saved')}</a><a class="pill" href="#mine">📋 ${t('my_ads')}</a>${st.isAdmin ? `<a class="pill" href="#admin">🛡 ${t('admin')}</a>` : ''}<a class="pill postbtn" href="#post">＋ ${t('post')}</a></nav>
    ${st.uid ? `<button class="pill acc" data-act="account" title="${esc(st.email)}">👤 <span class="tx">${t('account')}</span></button>` : `<button class="pill acc" data-act="auth" data-m="login">🔑 <span class="tx">${t('login')}</span></button>`}
    <label class="pill lpill"><span class="gl">🌐</span> <select id="langsel" aria-label="Language">${LANGS.map((l) => `<option value="${l[0]}" ${l[0] === LANG ? 'selected' : ''}>${l[1]}</option>`).join('')}</select></label>`;
  document.getElementById('bnav').innerHTML = [
    ['home', '🏠', t('home')],
    ['saved', '♡', t('saved')],
    ['post', '＋', t('post'), 'plus'],
    ['mine', '📋', t('my_ads')],
  ]
    .map(
      ([h, i, l, c]) =>
        `<a href="#${h}" class="${c || ''} ${r === h ? 'on' : ''}"${h === 'home' ? ' data-act="home"' : ''}><span class="i">${i}</span>${l}</a>`,
    )
    .join('');
  document.getElementById('ftr').innerHTML =
    `<div class="wrap"><div class="row" style="gap:8px;margin-bottom:6px">${LOGO.replace('<svg', '<svg style="width:26px;height:26px"')}<b style="color:var(--blue)">${t('brand')}</b><span class="sp"></span><span dir="ltr">maamila.com</span></div>
    <div>${t('about')}</div><div class="note"><a href="#terms" style="color:var(--blue);font-weight:700">📜 ${t('terms')}</a> · <a href="#post">＋ ${t('post')}</a> · © ${Number(2026).toLocaleString('fa-AF', { useGrouping: false })} ${t('brand')}</div></div>`;
}

/* ===== views ===== */
function vHome() {
  const key = filterKey();
  ensureList();
  const ready = st.listKey === key;
  const ads = ready ? st.list : [];
  const noFilters = st.city === 'all' && st.cat === 'all' && st.stype === 'all' && !searchWords(st.q).length;
  const where =
    st.city === 'all'
      ? t('all_af')
      : st.district
        ? `${st.district}، ${cityName(st.city)}`
        : cityName(st.city);
  const body =
    st.listErr === key || st.dbErr
      ? errBox()
      : !ready
        ? loadingBox()
        : ads.length
          ? `<div class="grid">${ads.map(adCard).join('')}</div>${st.more ? `<div class="row" style="justify-content:center;margin-top:16px"><button class="btn" data-act="more">${t('load_more')}</button></div>` : ''}`
          : !noFilters
            ? `<div class="empty"><div class="e">🔍</div><p>${t('no_results')}</p><a class="btn p" href="#post">＋ ${t('post')}</a></div>`
            : `<div class="empty" style="padding:44px 18px"><div class="e">🎉</div><h2 style="margin:6px 0">${t('first_t')}</h2><p style="margin:0 0 16px">${t('first_d')}</p><a class="btn p" href="#post" style="height:52px;font-size:16px">＋ ${t('post')}</a></div>`;
  return `<section class="hero"><div class="wrap"><h1>${t('hero')}</h1><p>${t('hero_d')}</p>
    <form class="sbox" id="sform"><input id="sq" type="search" placeholder="${t('search_ph')}" value="${esc(st.q)}" autocomplete="off"><button>🔍 ${t('search')}</button></form></div></section>
  <div class="wrap">
    <div class="cats">${[{ id: 'all', i: '🗂️', n: M(t('all')) }, ...CATS].map((c) => `<button class="cat ${st.cat === c.id ? 'on' : ''}" data-act="cat" data-id="${c.id}"><span class="ci">${c.i}</span>${L(c.n)}</button>`).join('')}</div>
    <div class="chips">${[
      ['all', t('all')],
      ['factory', '🏭 ' + t('factory')],
      ['shop', '🏪 ' + t('shop')],
      ['person', '👤 ' + t('person')],
      ['wholesale', '📦 ' + t('wholesale')],
    ]
      .map(
        ([k, l]) =>
          `<button class="chip ${st.stype === k ? 'on' : ''}" data-act="stype" data-k="${k}">${l}</button>`,
      )
      .join('')}
      <span class="sp"></span><select id="sortsel" aria-label="sort">${['new', 'cheap', 'exp'].map((k) => `<option value="${k}" ${st.sort === k ? 'selected' : ''}>${t('sort_' + k)}</option>`).join('')}</select></div>
    ${st.city !== 'all' ? `<div class="drow"><label>📍 ${t('district')}:</label><select id="distsel">${distOptions(st.city, st.district, t('all_districts'))}</select></div>` : ''}
    <div class="fh"><h2>${st.q.trim() ? `🔍 «${esc(st.q.trim())}»` : t('latest')}</h2><span class="faint" style="font-size:13px">${t('in_city', esc(where))}${ready ? ` · ${t('results', num(st.total))}` : ''}</span></div>
    ${body}
  </div>`;
}
function vAd(id) {
  const a = getAd(id);
  if (a === undefined)
    return `<div class="wrap">${st.err.has('ad:' + id) ? errBox() : loadingBox()}</div>`;
  if (!a)
    return `<div class="wrap"><div class="empty" style="margin-top:16px"><div class="e">🤷</div><p>${t('not_found')}</p><a class="btn" href="#home">${t('back_home')}</a></div></div>`;
  const c = catById(a.cat);
  const mine = a.owner && a.owner === st.uid;
  const { more, sim } = getRel(a);
  const sv = st.me.saved.includes(a.id);
  const ph = latinDigits(a.phone);
  return `<div class="wrap"><div class="bc"><a href="#home">${t('home')}</a> › <a href="#home" data-act="cat" data-id="${c.id}">${L(c.n)}</a></div>
  <div class="adp">
    <div class="gal card" style="padding:10px"><div class="main" id="gmain">${photo(a)}</div><div class="ths" id="gths"></div></div>
    <div class="card pad info">
      <div class="row" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}${stTag(a)}${saleTag(a)}</div>
      <h1>${esc(a.title)}</h1>
      <div class="faint" style="font-size:13px">📍 ${esc(placeName(a))} · ${t('posted')} ${ago(a.at)}</div>
      <div class="price">${priceHtml(a, 1)}</div>
      ${
        a.sold
          ? ''
          : `<div class="cta"><a class="btn call" href="tel:${esc(ph.replace(/\s/g, ''))}">📞 ${t('call')}</a>${a.wa ? `<a class="btn wa" href="https://wa.me/${waNum(a.phone)}" target="_blank" rel="noopener">💬 ${t('whatsapp')}</a>` : `<button class="btn" data-act="copy" data-p="${esc(ph)}">📋 ${t('copy')}</button>`}</div>
      <div class="num"><b dir="ltr">${esc(ph)}</b><button class="btn sm" data-act="copy" data-p="${esc(ph)}">${t('copy')}</button></div>`
      }
      <div class="seller"><div class="av" style="--h:${hashH(a.phone)}">${esc((a.name || '?').trim()[0] || '?')}</div><div style="flex:1;min-width:0"><div class="faint" style="font-size:12px">${t('seller')}</div><b>${esc(a.name)}</b><div class="faint" style="font-size:12.5px">${STYPE[a.stype]?.[0] || ''} ${t(a.stype)}</div></div>
        <button class="heart ${sv ? 'on' : ''}" style="position:static" data-act="save" data-id="${a.id}">${sv ? '♥' : '♡'}</button></div>
      <dl class="kv"><dt>${t('category')}</dt><dd>${c.i} ${L(c.n)}</dd><dt>${t('sale_type')}</dt><dd>${t(a.sale || 'retail')}</dd><dt>${t('province')}</dt><dd>${esc(cityName(a.city))}</dd>${a.district ? `<dt>${t('district')}</dt><dd>${esc(a.district)}</dd>` : ''}</dl>
      <h3 style="margin:14px 0 4px">${t('desc')}</h3><p style="white-space:pre-line;margin:0">${esc(a.desc) || '—'}</p>
      ${
        mine
          ? `<div class="row" style="margin-top:16px;flex-wrap:wrap"><a class="btn sm" href="#edit-${a.id}">✎ ${t('edit')}</a>${soldBtn(a)}${delBtn(a)}</div>`
          : st.isAdmin
            ? `<div class="row" style="margin-top:16px;flex-wrap:wrap;align-items:center"><span class="faint" style="font-size:12.5px">🛡 ${t('admin')}:</span>${soldBtn(a)}${delBtn(a)}</div>`
            : ''
      }
      <div class="safe">${t('safety')}</div>
    </div></div>
  ${more.length ? `<div class="fh" style="margin-top:20px"><h2>${t('more_from')}</h2></div><div class="grid">${more.map(adCard).join('')}</div>` : ''}
  ${sim.length ? `<div class="fh" style="margin-top:20px"><h2>${t('similar')}</h2></div><div class="grid">${sim.map(adCard).join('')}</div>` : ''}</div>`;
}
function loadGallery(a) {
  if (!a || !a.images.length || cur() !== 'ad-' + a.id) return;
  const imgs = a.images;
  const main = document.getElementById('gmain');
  const ths = document.getElementById('gths');
  if (!main) return;
  const show = (i) => {
    main.innerHTML = `<div class="ph" style="--h:${hueOf(a)}"><img src="${esc(imgs[i])}" alt=""></div>`;
    ths.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i));
  };
  ths.innerHTML =
    imgs.length > 1
      ? imgs.map((s, i) => `<button data-i="${i}"><img src="${esc(s)}" alt=""></button>`).join('')
      : '';
  ths.querySelectorAll('button').forEach((b) => (b.onclick = () => show(+b.dataset.i)));
  show(0);
}
function vPost(editId) {
  if (!st.uid) return `<div class="wrap" style="max-width:680px">${loginPrompt(t('login_needed'))}</div>`;
  let ed = null;
  if (editId) {
    ed = getAd(editId);
    if (ed === undefined)
      return `<div class="wrap">${st.err.has('ad:' + editId) ? errBox() : loadingBox()}</div>`;
    if (!ed || ed.owner !== st.uid) return vAd(editId);
  }
  if (!st.draft || st.draft._for !== (editId || 'new')) {
    st.draft = {
      _for: editId || 'new',
      imgs: [],
      stype: ed ? ed.stype : st.me.stype || 'person',
      sale: ed ? ed.sale : 'retail',
      loaded: !ed,
    };
    if (ed) {
      st.draft.imgs = [...(ed.images || [])];
      st.draft.loaded = true;
    }
  }
  const d = st.draft;
  const a = ed || {
    title: '',
    cat: '',
    price: '',
    city: st.me.city || (st.city !== 'all' ? st.city : ''),
    district: st.me.district || '',
    phone: st.me.phone,
    name: st.me.name,
    wa: st.me.wa !== false,
    desc: '',
  };
  const seg = (name, opts, val) =>
    `<div class="seg">${opts.map(([v, i, l]) => `<label><input type="radio" name="${name}" value="${v}" ${val === v ? 'checked' : ''}><span class="i">${i}</span>${l}</label>`).join('')}</div>`;
  return `<div class="wrap" style="max-width:680px"><h1 style="font-size:21px;margin:16px 0 10px">${ed ? '✎ ' + t('edit_t') : '＋ ' + t('post_t')}</h1>
  <form id="postform" class="card pad" novalidate>
    <div class="fld"><label>📷 ${t('photos')}</label><div class="phs" id="phs"></div></div>
    <div class="fld"><label>${t('title')} *</label><input name="title" maxlength="90" placeholder="${t('title_ph')}" value="${esc(a.title)}"></div>
    <div class="fld"><label>${t('category')} *</label><select name="cat"><option value="">—</option>${CATS.map((c) => `<option value="${c.id}" ${a.cat === c.id ? 'selected' : ''}>${c.i} ${L(c.n)}</option>`).join('')}</select></div>
    <div class="fld"><label>${t('price')}</label><input name="price" inputmode="numeric" placeholder="0" value="${a.price ? esc(a.price) : ''}"><div class="h">${t('price_h')}</div></div>
    <div class="fld"><label>${t('seller_type')}</label>${seg(
      'stype',
      [
        ['factory', '🏭', t('factory')],
        ['shop', '🏪', t('shop')],
        ['person', '👤', t('person')],
      ],
      d.stype,
    )}</div>
    <div class="fld"><label>${t('sale_type')}</label>${seg(
      'sale',
      [
        ['retail', '🛍️', t('retail')],
        ['wholesale', '📦', t('wholesale')],
        ['both', '🔁', t('both')],
      ],
      d.sale,
    )}</div>
    <div class="g2f"><div class="fld"><label>${t('province')} *</label><select name="city"><option value="">—</option>${CITIES.map(([k, n]) => `<option value="${k}" ${a.city === k ? 'selected' : ''}>${L(n)}</option>`).join('')}</select></div>
    <div class="fld"><label>${t('district')} *</label><select name="district">${distOptions(a.city, a.district || '')}</select></div></div>
    <div class="fld"><label>${t('desc')}</label><textarea name="desc" maxlength="1500">${esc(a.desc)}</textarea></div>
    <div class="fld"><label>${t('name')} *</label><input name="name" maxlength="60" value="${esc(a.name)}"></div>
    <div class="fld"><label>${t('phone')} *</label><input name="phone" type="tel" dir="ltr" maxlength="16" placeholder="07XX XXX XXX" value="${esc(a.phone)}" style="text-align:start"><label class="chk"><input type="checkbox" name="wa" ${a.wa ? 'checked' : ''}> 💬 ${t('has_wa')}</label></div>
    <p class="faint" style="font-size:13px;text-align:center;margin:0 0 10px">${t('agree', `<a href="#terms" style="color:var(--blue);font-weight:700">${t('terms')}</a>`)}</p><button class="btn p blk" style="height:54px;font-size:16px">${ed ? t('save') : t('publish')}</button>
    ${ed ? `<a class="btn blk" style="margin-top:8px" href="#ad-${ed.id}">${t('cancel')}</a>` : ''}
  </form></div>`;
}
function drawPhotos() {
  const box = document.getElementById('phs');
  if (!box || !st.draft) return;
  const d = st.draft;
  box.innerHTML =
    d.imgs
      .map(
        (im, i) =>
          `<div class="th"><img src="${esc(im)}" alt=""><button type="button" data-act="rmimg" data-i="${i}">✕</button></div>`,
      )
      .join('') +
    (d.imgs.length < 3 ? `<label class="addp" for="pfile"><b>＋</b>${t('add_photo')}</label>` : '');
}
function vMine() {
  if (!st.uid)
    return `<div class="wrap" style="max-width:780px"><div class="tabs"><a class="on" href="#mine">📋 ${t('my_ads')}</a><a href="#saved">♡ ${t('saved')}</a></div>${loginPrompt(t('login_needed_mine'))}</div>`;
  const mine = getMine();
  return `<div class="wrap" style="max-width:780px"><div class="tabs"><a class="on" href="#mine">📋 ${t('my_ads')}</a><a href="#saved">♡ ${t('saved')}</a></div>
  ${
    !mine
      ? st.err.has('mine:' + st.uid)
        ? errBox()
        : loadingBox()
      : mine.length
      ? `<div class="card">${mine
          .map(
            (
              a,
            ) => `<div class="mine"><a href="#ad-${a.id}">${photo(a)}</a><div style="flex:1;min-width:0"><a href="#ad-${a.id}"><b>${esc(a.title)}</b></a>
    <div style="font-weight:800">${priceHtml(a)}</div><div class="faint" style="font-size:12px">📍 ${esc(placeName(a))} · ${ago(a.at)} ${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}</div>
    <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:6px"><a class="btn sm" href="#edit-${a.id}">✎ ${t('edit')}</a><button class="btn sm" data-act="sold" data-id="${a.id}">${a.sold ? '↺ ' + t('relist') : '✓ ' + t('mark_sold')}</button><button class="btn sm d" data-act="del" data-id="${a.id}">${t('del')}</button></div></div></div>`,
          )
          .join('')}</div>`
      : `<div class="empty"><div class="e">📋</div><p>${t('no_my_ads')}</p><a class="btn p" href="#post">＋ ${t('post_first')}</a></div>`
  }</div>`;
}
function vSaved() {
  const ads = getSaved();
  const failed = st.err.has('saved:' + savedIds().join(','));
  return `<div class="wrap"><div class="tabs"><a href="#mine">📋 ${t('my_ads')}</a><a class="on" href="#saved">♡ ${t('saved')}</a></div>
  ${!ads ? (failed ? errBox() : loadingBox()) : ads.length ? `<div class="grid">${ads.map(adCard).join('')}</div>` : `<div class="empty"><div class="e">♡</div><p>${t('no_saved')}</p></div>`}</div>`;
}

function vAdmin() {
  const wrap = (b) =>
    `<div class="wrap" style="max-width:860px"><h1 style="font-size:21px;margin:16px 0 4px">🛡 ${t('admin')}</h1>${b}</div>`;
  if (!st.uid) return wrap(loginPrompt(t('admin_only')));
  if (st.isAdmin === null) return wrap(loadingBox());
  if (!st.isAdmin) return wrap(`<div class="empty"><div class="e">🔒</div><p>${t('admin_only')}</p></div>`);
  const ads = getAdminAds();
  if (!ads) return wrap(st.err.has('admin') ? errBox() : loadingBox());
  return wrap(`<p class="faint" style="font-size:13px;margin:0 0 12px">${t('admin_d')}</p>${
    ads.length
      ? `<div class="card">${ads
          .map(
            (a) => `<div class="mine"><a href="#ad-${a.id}">${photo(a)}</a><div style="flex:1;min-width:0"><a href="#ad-${a.id}"><b>${esc(a.title)}</b></a>
    <div class="faint" style="font-size:12px">👤 ${esc(a.name)} · <span dir="ltr">${esc(latinDigits(a.phone))}</span> · 📍 ${esc(placeName(a))} · ${ago(a.at)} ${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}</div>
    <div class="row" style="margin-top:6px;flex-wrap:wrap;gap:6px">${soldBtn(a)}${delBtn(a)}</div></div></div>`,
          )
          .join('')}</div>`
      : `<div class="empty"><div class="e">📋</div><p>${t('no_results')}</p></div>`
  }`);
}

function vTerms() {
  const d = TERMS[LANG];
  return `<div class="wrap" style="max-width:780px"><div class="card pad terms" style="margin-top:16px"><h1 style="font-size:22px;margin:0 0 4px">📜 ${d.title}</h1><div class="faint" style="font-size:13px;margin-bottom:12px">${d.upd}</div><p>${d.intro}</p>
  ${d.s.map(([h, b], i) => `<h3>${num(i + 1)}. ${h}</h3><p>${b}</p>`).join('')}
  <a class="btn p" href="#home" style="margin-top:8px">${t('back_home')}</a></div></div>`;
}

/* ===== router ===== */
const cur = () => {
  let h = (location.hash || '#home').slice(1);
  try {
    h = decodeURIComponent(h);
  } catch (e) {} // a broken address like "#%" just shows the home page
  return h || 'home';
};
let last = '';
function route(soft) {
  const r = cur();
  const sy = window.scrollY;
  if (r !== last && !/^(post|edit-)/.test(r)) st.draft = null;
  let h;
  if (r.startsWith('ad-')) h = vAd(r.slice(3));
  else if (r === 'post') h = vPost();
  else if (r.startsWith('edit-')) h = vPost(r.slice(5));
  else if (r === 'mine') h = vMine();
  else if (r === 'saved') h = vSaved();
  else if (r === 'terms') h = vTerms();
  else if (r === 'admin') h = vAdmin();
  else h = vHome();
  // keep what is being typed in the search box when the page is drawn again
  const ae = document.activeElement;
  const typing = ae && ae.id === 'sq' ? [ae.value, ae.selectionStart, ae.selectionEnd] : null;
  document.getElementById('app').innerHTML = h;
  const sq = typing && document.getElementById('sq');
  if (sq) {
    sq.value = typing[0];
    sq.focus({ preventScroll: true });
    try {
      sq.setSelectionRange(typing[1], typing[2]);
    } catch (e) {}
  }
  renderChrome();
  if (r !== last) window.scrollTo(0, 0);
  else if (soft) window.scrollTo(0, sy);
  last = r;
  if (r.startsWith('ad-')) loadGallery(st.byId.get(r.slice(3)));
  if (document.getElementById('phs')) drawPhotos();
}
window.addEventListener('hashchange', () => route());

/* ===== events ===== */
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'mclose') {
    if (e.target === a || a.tagName === 'BUTTON' || a.tagName === 'A') modal('');
    return;
  }
  if (act === 'auth') {
    e.preventDefault();
    openAuth(a.dataset.m);
    return;
  }
  if (act === 'resend') {
    e.preventDefault();
    const email = (a.closest('form') || {}).dataset?.email;
    if (!email || !st.sb) return;
    st.sb.auth.resend({ type: 'signup', email }).then(({ error }) => toast(error ? t('save_err') : t('verify_sent'), error ? 1 : 0));
    return;
  }
  if (act === 'home') {
    // logo / Home: back to the start page with search and filters cleared (also when already on it)
    e.preventDefault();
    Object.assign(st, { q: '', cat: 'all', stype: 'all', sort: 'new', district: '' });
    modal('');
    if (cur() !== 'home') location.hash = '#home';
    else route(true);
    window.scrollTo(0, 0);
    return;
  }
  if (act === 'account') {
    openAccount();
    return;
  }
  if (act === 'go') {
    modal('');
    location.hash = '#' + a.dataset.h;
    return;
  }
  if (act === 'logout') {
    modal('');
    st.sb.auth.signOut().then(() => {
      setUser(null);
      checkAdmin();
      toast(t('logged_out'));
      renderChrome();
      route(true);
    });
    return;
  }
  if (act === 'save') {
    e.preventDefault();
    e.stopPropagation();
    const s = new Set(st.me.saved);
    const on = !s.has(a.dataset.id);
    on ? s.add(a.dataset.id) : s.delete(a.dataset.id);
    st.me.saved = [...s];
    saveMe();
    document.querySelectorAll(`[data-act=save][data-id="${a.dataset.id}"]`).forEach((b) => {
      b.classList.toggle('on', on);
      b.textContent = on ? '♥' : '♡';
    });
    toast(on ? t('saved_ok') : t('unsaved'));
    if (st.savedAds) {
      if (on) st.savedAds = null;
      else {
        st.savedAds.ads = st.savedAds.ads.filter((x) => x.id !== a.dataset.id);
        st.savedAds.key = savedIds().join(',');
      }
    }
    if (cur() === 'saved') route(true);
    return;
  }
  if (act === 'cat') {
    e.preventDefault();
    st.cat = a.dataset.id;
    if (cur() !== 'home') location.hash = '#home';
    else route(true);
    return;
  }
  if (act === 'stype') {
    st.stype = a.dataset.k;
    route(true);
    return;
  }
  if (act === 'city') {
    modal(
      `<h3>${t('choose_city')}</h3><div class="clist">${[['all', M(t('all_af'))], ...CITIES].map(([k, n]) => `<button data-act="setcity" data-k="${k}" class="${st.city === k ? 'on' : ''}">📍 ${L(n)}</button>`).join('')}</div>`,
    );
    return;
  }
  if (act === 'setcity') {
    st.city = a.dataset.k;
    st.district = '';
    LS.set('city', st.city);
    modal('');
    if (cur() !== 'home') location.hash = '#home';
    else route(true);
    return;
  }
  if (act === 'copy') {
    const p = a.dataset.p;
    (navigator.clipboard ? navigator.clipboard.writeText(latinDigits(p)) : Promise.reject())
      .then(() => toast(t('copied')))
      .catch(() => toast(p));
    return;
  }
  if (act === 'rmimg') {
    st.draft.imgs.splice(+a.dataset.i, 1);
    drawPhotos();
    return;
  }
  if (act === 'retry') {
    st.err.clear();
    st.listErr = '';
    if (st.dbErr) location.reload();
    else route(true);
    return;
  }
  if (act === 'more') {
    loadMore(a);
    return;
  }
  if (act === 'sold') {
    const ad = findAd(a.dataset.id);
    if (ad && ad.owner !== st.uid && !st.isAdmin) return;
    if (ad)
      setSold(ad, !ad.sold)
        .then(() => route(true))
        .catch(() => {});
    return;
  }
  if (act === 'del') {
    const id = a.dataset.id;
    const own = (findAd(id) || {}).owner === st.uid;
    modal(
      `<h3>${t('confirm_del')}</h3><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-act="mclose">${t('cancel')}</button><button class="btn p" id="mok" style="background:var(--red);border-color:var(--red)">${t('del')}</button></div>`,
    );
    document.getElementById('mok').onclick = async () => {
      modal('');
      try {
        await delAd(id);
        toast(t('deleted'));
        if (cur().startsWith('ad-')) location.hash = own ? '#mine' : '#admin';
        else route(true);
      } catch (_) {}
    };
    return;
  }
});
document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('bad')) e.target.classList.remove('bad');
});
document.addEventListener('change', (e) => {
  if (e.target.classList && e.target.classList.contains('bad')) e.target.classList.remove('bad');
  const el = e.target;
  if (el.id === 'langsel') {
    LANG = el.value;
    try {
      localStorage.setItem('bzk:lang', LANG);
    } catch (_) {}
    route(true);
    return;
  }
  if (el.id === 'sortsel') {
    st.sort = el.value;
    route(true);
    return;
  }
  if (el.id === 'distsel') {
    st.district = el.value;
    route(true);
    return;
  }
  if (el.name === 'city' && el.form && el.form.id === 'postform') {
    const ds = el.form.elements.district;
    ds.innerHTML = distOptions(el.value, '');
    ds.classList.remove('bad');
    return;
  }
  if (el.id === 'pfile') {
    const files = [...el.files];
    el.value = '';
    if (!st.draft) return;
    const room = 3 - st.draft.imgs.length;
    if (files.length > room) toast(t('max3'));
    files.slice(0, Math.max(0, room)).forEach((f) =>
      resize(f, 900, 60000)
        .then((u) => {
          if (st.draft && st.draft.imgs.length < 3) {
            st.draft.imgs.push(u);
            drawPhotos();
          }
        })
        .catch(() => toast(t('photo_err'), 1)),
    );
    return;
  }
  if (el.name === 'stype' && st.draft) st.draft.stype = el.value;
  if (el.name === 'sale' && st.draft) st.draft.sale = el.value;
});
function resize(src, max, budget) {
  return new Promise((res, rej) => {
    const go = (url) => {
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, max / Math.max(im.width, im.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(im.width * sc);
        cv.height = Math.round(im.height * sc);
        const cx = cv.getContext('2d');
        cx.fillStyle = '#fff';
        cx.fillRect(0, 0, cv.width, cv.height);
        cx.drawImage(im, 0, 0, cv.width, cv.height);
        let q = 0.8,
          u = cv.toDataURL('image/jpeg', q);
        while (u.length > budget * 1.37 && q > 0.35) {
          q -= 0.1;
          u = cv.toDataURL('image/jpeg', q);
        }
        res(u);
      };
      im.onerror = rej;
      im.src = url;
    };
    if (typeof src === 'string') go(src);
    else {
      const fr = new FileReader();
      fr.onload = () => go(fr.result);
      fr.onerror = rej;
      fr.readAsDataURL(src);
    }
  });
}
document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  if (f.id === 'authform') {
    submitAuth(f);
    return;
  }
  if (f.id === 'sform') {
    st.q = document.getElementById('sq').value;
    document.getElementById('sq').blur();
    route(true);
    setTimeout(
      () => document.querySelector('.fh')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
    return;
  }
  if (f.id === 'postform') {
    const fd = Object.fromEntries(new FormData(f).entries());
    let ok = true;
    ['title', 'cat', 'city', 'district', 'name', 'phone'].forEach((n) => {
      const bad = !String(fd[n] || '').trim();
      f.elements[n].classList.toggle('bad', bad);
      if (bad) ok = false;
    });
    const digits = latinDigits(fd.phone || '').replace(/\D/g, '');
    if (digits.length < 9) {
      f.elements.phone.classList.add('bad');
      ok = false;
    }
    if (!ok) {
      toast(t('fill'), 1);
      f.querySelector('.bad')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const editId = cur().startsWith('edit-') ? cur().slice(5) : null;
    const known = editId && st.byId.get(editId);
    const ex = known && known.owner === st.uid ? known : null;
    const d = st.draft;
    const btn = f.querySelector('button.p');
    btn.disabled = true;
    try {
      const id = ex ? ex.id : crypto.randomUUID();
      const first = d.imgs[0] || '';
      const thumbData = first.startsWith('data:') ? await resize(first, 420, 22000) : '';
      const keepThumb = !first ? '' : ex && first === ex.images[0] ? ex.thumb : first;
      const ad = {
        title: fd.title.trim().slice(0, 90),
        cat: fd.cat,
        price: toNum(fd.price),
        stype: d.stype || 'person',
        sale: d.sale || 'retail',
        city: fd.city,
        district: (fd.district || '').slice(0, 60),
        desc: (fd.desc || '').trim().slice(0, 1500),
        name: fd.name.trim().slice(0, 60),
        phone: latinDigits(fd.phone).trim().slice(0, 16),
        wa: !!fd.wa,
        thumb: keepThumb,
        thumbData,
        sold: ex ? ex.sold : false,
      };
      await saveAd(id, ad, d.imgs, !ex);
      st.me = {
        ...st.me,
        name: ad.name,
        phone: ad.phone,
        wa: ad.wa,
        city: ad.city,
        district: ad.district,
        stype: ad.stype,
      };
      saveMe();
      st.draft = null;
      toast(ex ? t('updated') : t('published'));
      location.hash = '#ad-' + id;
    } catch (err) {
      btn.disabled = false;
      if (err && err.message === LOGIN_REQUIRED) return; // the login window is already open
      console.error(err);
      toast(/ad_limit/.test((err && err.message) || '') ? t('limit_err') : t('save_err'), 1);
    }
  }
});

route();
initDb();
// Lets the site be installed as an app (see sw.js).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
