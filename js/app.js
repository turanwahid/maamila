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
  uid: null,
  ads: [],
  loaded: false,
  me: Object.assign({ saved: [], name: '', phone: '', wa: true, city: '' }, LS.get('me', {})),
  city: LS.get('city', 'all'),
  district: '',
  cat: 'all',
  stype: 'all',
  sort: 'new',
  q: '',
  draft: null,
};
const COLS =
  'id,created_at,owner,title,cat,price,stype,sale,city,district,descr,name,phone,wa,images,thumb,sold';
const fromRow = (r) => ({
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
  images: r.images || [],
  thumb: r.thumb || '',
  nimg: (r.images || []).length,
  sold: !!r.sold,
  icon: catById(r.cat).i,
});
function saveMe() {
  LS.set('me', st.me);
}
async function initDb() {
  if (!window.supabase) {
    toast(t('save_err'), 1);
    return;
  }
  st.sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  try {
    const { data } = await st.sb.auth.getSession();
    st.uid = data && data.session ? data.session.user.id : null;
  } catch (e) {}
  await loadAds();
  setInterval(() => {
    if (cur() === 'home' && !document.hidden) loadAds();
  }, 60000);
}
async function loadAds() {
  const { data, error } = await st.sb
    .from('ads')
    .select(COLS)
    .order('created_at', { ascending: false })
    .limit(1000);
  if (!error) {
    st.ads = (data || []).map(fromRow);
  }
  st.loaded = true;
  soft(true);
}
async function ensureUser() {
  if (st.uid) return st.uid;
  const { data, error } = await st.sb.auth.signInAnonymously();
  if (error) throw error;
  st.uid = data.user.id;
  return st.uid;
}
function dataUrlToBlob(u) {
  const [h, b] = u.split(',');
  const bin = atob(b);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: (h.match(/:(.*?);/) || [])[1] || 'image/jpeg' });
}
async function upload(path, dataUrl) {
  const { error } = await st.sb.storage
    .from(BUCKET)
    .upload(path, dataUrlToBlob(dataUrl), {
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
  const i = st.ads.findIndex((x) => x.id === id);
  if (i >= 0) st.ads[i] = a;
  else st.ads.unshift(a);
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
  const { error } = await st.sb.from('ads').update({ sold }).eq('id', ad.id);
  if (error) {
    toast(t('save_err'), 1);
    throw error;
  }
  ad.sold = sold;
}
async function delAd(id) {
  const { error } = await st.sb.from('ads').delete().eq('id', id);
  if (error) {
    toast(t('save_err'), 1);
    throw error;
  }
  st.ads = st.ads.filter((x) => x.id !== id);
  if (st.uid) cleanupPhotos(st.uid, id, []);
}
async function getImgs(id) {
  const a = st.ads.find((x) => x.id === id);
  return a ? a.images : [];
}
let sT = null;
function soft(force) {
  clearTimeout(sT);
  sT = setTimeout(() => {
    if (!force && document.getElementById('postform')) return;
    if (document.getElementById('postform')) return;
    const a = document.activeElement;
    if (!force && a && /INPUT|TEXTAREA/.test(a.tagName)) return;
    route(true);
  }, 100);
}

/* ===== helpers ===== */
const allAds = () => [...st.ads.filter((a) => a && a.title && a.cat), ...DEMO_ADS];
const adById = (id) => allAds().find((a) => a.id === id);
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
function photo(a, extra = '') {
  return `<div class="ph" style="--h:${hueOf(a)}" ${extra}><span>${a.icon || catById(a.cat).i}</span>${a.thumb ? `<img src="${esc(a.thumb)}" alt="" loading="lazy">` : ''}</div>`;
}
function adCard(a) {
  const sv = st.me.saved.includes(a.id);
  return `<a class="ad" href="#ad-${a.id}"><div style="position:relative">${photo(a)}
    <div class="ph-tags" style="position:absolute;top:8px;inset-inline-start:8px;display:flex;gap:4px;flex-wrap:wrap;max-width:75%">${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}${stTag(a)}${saleTag(a)}</div>
    <button class="heart ${sv ? 'on' : ''}" data-act="save" data-id="${a.id}" aria-label="${t('saved')}">${sv ? '♥' : '♡'}</button>
    ${a.demo ? `<span class="tag demo" style="position:absolute;bottom:8px;inset-inline-end:8px">${t('sample')}</span>` : ''}</div>
    <div class="bd"><div class="tt">${esc(a.title)}</div><div class="pr">${priceHtml(a)}</div><div class="mt">📍 ${esc(placeName(a))} · ${ago(a.at)}</div></div></a>`;
}
function toast(m, err) {
  const d = document.createElement('div');
  d.className = 'toast' + (err ? ' err' : '');
  d.textContent = m;
  document.getElementById('toasts').appendChild(d);
  setTimeout(() => d.remove(), 2800);
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
  document.getElementById('hdr').innerHTML = `<a class="logo" href="#home">${LOGO}${t('brand')}</a>
    <button class="pill cityp" data-act="city">📍 <span class="tx">${esc(cityLabel)}</span> ▾</button>
    <span class="sp"></span>
    <nav class="dnav"><a class="pill" href="#saved">♡ ${t('saved')}</a><a class="pill" href="#mine">📋 ${t('my_ads')}</a><a class="pill postbtn" href="#post">＋ ${t('post')}</a></nav>
    <label class="pill lpill"><span class="gl">🌐</span> <select id="langsel" aria-label="Language">${LANGS.map((l) => `<option value="${l[0]}" ${l[0] === LANG ? 'selected' : ''}>${l[1]}</option>`).join('')}</select></label>`;
  document.getElementById('bnav').innerHTML = [
    ['home', '🏠', t('home')],
    ['saved', '♡', t('saved')],
    ['post', '＋', t('post'), 'plus'],
    ['mine', '📋', t('my_ads')],
  ]
    .map(
      ([h, i, l, c]) =>
        `<a href="#${h}" class="${c || ''} ${r === h ? 'on' : ''}"><span class="i">${i}</span>${l}</a>`,
    )
    .join('');
  document.getElementById('ftr').innerHTML =
    `<div class="wrap"><div class="row" style="gap:8px;margin-bottom:6px">${LOGO.replace('<svg', '<svg style="width:26px;height:26px"')}<b style="color:var(--blue)">${t('brand')}</b><span class="sp"></span><span dir="ltr">maamila.com</span></div>
    <div>${t('about')}</div><div class="note"><a href="#terms" style="color:var(--blue);font-weight:700">📜 ${t('terms')}</a> · <a href="#post">＋ ${t('post')}</a> · © ${Number(2026).toLocaleString('fa-AF', { useGrouping: false })} ${t('brand')}</div></div>`;
}

/* ===== views ===== */
function filtered() {
  let a = allAds();
  if (st.city !== 'all') a = a.filter((x) => x.city === st.city);
  if (st.city !== 'all' && st.district) a = a.filter((x) => x.district === st.district);
  if (st.cat !== 'all') a = a.filter((x) => x.cat === st.cat);
  if (st.stype === 'wholesale') a = a.filter((x) => x.sale !== 'retail');
  else if (st.stype !== 'all') a = a.filter((x) => x.stype === st.stype);
  if (st.q.trim()) {
    const ws = norm(st.q).split(' ');
    a = a.filter((x) => {
      const hay = norm(
        [
          x.title,
          x.desc,
          x.name,
          ...Object.values(catById(x.cat).n),
          ...Object.values((provById(x.city) || [0, {}])[1]),
          x.district || '',
        ].join(' '),
      );
      return ws.every((w) => hay.includes(w));
    });
  }
  const S = {
    new: (x, y) => y.at - x.at,
    cheap: (x, y) => (x.price || 1e12) - (y.price || 1e12),
    exp: (x, y) => (y.price || 0) - (x.price || 0),
  };
  return [...a].sort(S[st.sort] || S.new).sort((x, y) => (x.sold ? 1 : 0) - (y.sold ? 1 : 0));
}
function vHome() {
  const ads = filtered();
  const where =
    st.city === 'all'
      ? t('all_af')
      : st.district
        ? `${st.district}، ${cityName(st.city)}`
        : cityName(st.city);
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
    <div class="fh"><h2>${st.q.trim() ? `🔍 «${esc(st.q.trim())}»` : t('latest')}</h2><span class="faint" style="font-size:13px">${t('in_city', esc(where))} · ${t('results', num(ads.length))}</span></div>
    ${!st.loaded ? `<div class="empty"><div class="e">⏳</div></div>` : ads.length ? `<div class="grid">${ads.map(adCard).join('')}</div>` : allAds().length ? `<div class="empty"><div class="e">🔍</div><p>${t('no_results')}</p><a class="btn p" href="#post">＋ ${t('post')}</a></div>` : `<div class="empty" style="padding:44px 18px"><div class="e">🎉</div><h2 style="margin:6px 0">${t('first_t')}</h2><p style="margin:0 0 16px">${t('first_d')}</p><a class="btn p" href="#post" style="height:52px;font-size:16px">＋ ${t('post')}</a></div>`}
  </div>`;
}
function vAd(id) {
  const a = adById(id);
  if (!a)
    return `<div class="wrap"><div class="empty" style="margin-top:16px"><div class="e">🤷</div><p>${t('not_found')}</p><a class="btn" href="#home">${t('back_home')}</a></div></div>`;
  const c = catById(a.cat);
  const mine = a.owner && a.owner === st.uid;
  const more = allAds()
    .filter((x) => x.id !== a.id && x.phone === a.phone)
    .slice(0, 4);
  const sim = allAds()
    .filter((x) => x.id !== a.id && x.cat === a.cat && x.phone !== a.phone)
    .slice(0, 8);
  const sv = st.me.saved.includes(a.id);
  const ph = latinDigits(a.phone);
  return `<div class="wrap"><div class="bc"><a href="#home">${t('home')}</a> › <a href="#home" data-act="cat" data-id="${c.id}">${L(c.n)}</a></div>
  <div class="adp">
    <div class="gal card" style="padding:10px"><div class="main" id="gmain">${photo(a)}</div><div class="ths" id="gths"></div></div>
    <div class="card pad info">
      <div class="row" style="flex-wrap:wrap;gap:4px;margin-bottom:6px">${a.sold ? `<span class="tag sold">${t('sold')}</span>` : ''}${stTag(a)}${saleTag(a)}${a.demo ? `<span class="tag demo">${t('sample')}</span>` : ''}</div>
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
      ${mine ? `<div class="row" style="margin-top:16px;flex-wrap:wrap"><a class="btn sm" href="#edit-${a.id}">✎ ${t('edit')}</a><button class="btn sm" data-act="sold" data-id="${a.id}">${a.sold ? '↺ ' + t('relist') : '✓ ' + t('mark_sold')}</button><button class="btn sm d" data-act="del" data-id="${a.id}">${t('del')}</button></div>` : ''}
      <div class="safe">${t('safety')}</div>
    </div></div>
  ${more.length ? `<div class="fh" style="margin-top:20px"><h2>${t('more_from')}</h2></div><div class="grid">${more.map(adCard).join('')}</div>` : ''}
  ${sim.length ? `<div class="fh" style="margin-top:20px"><h2>${t('similar')}</h2></div><div class="grid">${sim.map(adCard).join('')}</div>` : ''}</div>`;
}
async function loadGallery(a) {
  if (!a || !a.nimg) return;
  const imgs = await getImgs(a.id);
  if (!imgs.length || cur() !== 'ad-' + a.id) return;
  const main = document.getElementById('gmain');
  const ths = document.getElementById('gths');
  if (!main) return;
  const show = (i) => {
    main.innerHTML = `<div class="ph" style="--h:${hueOf(a)}"><img src="${imgs[i]}" alt=""></div>`;
    ths.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i));
  };
  ths.innerHTML =
    imgs.length > 1
      ? imgs.map((s, i) => `<button data-i="${i}"><img src="${s}" alt=""></button>`).join('')
      : '';
  ths.querySelectorAll('button').forEach((b) => (b.onclick = () => show(+b.dataset.i)));
  show(0);
}
function vPost(editId) {
  const ed = editId ? st.ads.find((x) => x.id === editId && x.owner === st.uid) : null;
  if (editId && !ed) return vAd(editId);
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
          `<div class="th"><img src="${im}" alt=""><button type="button" data-act="rmimg" data-i="${i}">✕</button></div>`,
      )
      .join('') +
    (d.imgs.length < 3 ? `<label class="addp" for="pfile"><b>＋</b>${t('add_photo')}</label>` : '');
}
function vMine() {
  const mine = st.ads.filter((a) => a.owner === st.uid).sort((a, b) => b.at - a.at);
  return `<div class="wrap" style="max-width:780px"><div class="tabs"><a class="on" href="#mine">📋 ${t('my_ads')}</a><a href="#saved">♡ ${t('saved')}</a></div>
  ${
    mine.length
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
  const ads = st.me.saved.map(adById).filter(Boolean);
  return `<div class="wrap"><div class="tabs"><a href="#mine">📋 ${t('my_ads')}</a><a class="on" href="#saved">♡ ${t('saved')}</a></div>
  ${ads.length ? `<div class="grid">${ads.map(adCard).join('')}</div>` : `<div class="empty"><div class="e">♡</div><p>${t('no_saved')}</p></div>`}</div>`;
}

function vTerms() {
  const d = TERMS[LANG];
  return `<div class="wrap" style="max-width:780px"><div class="card pad terms" style="margin-top:16px"><h1 style="font-size:22px;margin:0 0 4px">📜 ${d.title}</h1><div class="faint" style="font-size:13px;margin-bottom:12px">${d.upd}</div><p>${d.intro}</p>
  ${d.s.map(([h, b], i) => `<h3>${num(i + 1)}. ${h}</h3><p>${b}</p>`).join('')}
  <a class="btn p" href="#home" style="margin-top:8px">${t('back_home')}</a></div></div>`;
}

/* ===== router ===== */
const cur = () => decodeURIComponent((location.hash || '#home').slice(1)) || 'home';
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
  else h = vHome();
  document.getElementById('app').innerHTML = h;
  renderChrome();
  if (r !== last) window.scrollTo(0, 0);
  else if (soft) window.scrollTo(0, sy);
  last = r;
  if (r.startsWith('ad-')) loadGallery(adById(r.slice(3)));
  if (document.getElementById('phs')) drawPhotos();
}
window.addEventListener('hashchange', () => route());

/* ===== events ===== */
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const act = a.dataset.act;
  if (act === 'mclose') {
    if (e.target === a || a.tagName === 'BUTTON') modal('');
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
  if (act === 'sold') {
    const ad = st.ads.find((x) => x.id === a.dataset.id && x.owner === st.uid);
    if (ad)
      setSold(ad, !ad.sold)
        .then(() => route(true))
        .catch(() => {});
    return;
  }
  if (act === 'del') {
    const id = a.dataset.id;
    modal(
      `<h3>${t('confirm_del')}</h3><div class="row" style="justify-content:flex-end;margin-top:16px"><button class="btn" data-act="mclose">${t('cancel')}</button><button class="btn p" id="mok" style="background:var(--red);border-color:var(--red)">${t('del')}</button></div>`,
    );
    document.getElementById('mok').onclick = async () => {
      modal('');
      try {
        await delAd(id);
        toast(t('deleted'));
        if (cur().startsWith('ad-')) location.hash = '#mine';
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
      resize(f, 900, 60000).then((u) => {
        if (st.draft.imgs.length < 3) {
          st.draft.imgs.push(u);
          drawPhotos();
        }
      }),
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
    const ex = editId && st.ads.find((x) => x.id === editId && x.owner === st.uid);
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
      console.error(err);
      toast(t('save_err'), 1);
      btn.disabled = false;
    }
  }
});

route();
initDb();
