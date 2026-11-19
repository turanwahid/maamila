-- Maamila: database + photo storage setup.
-- Safe to run again: re-running it on the live project applies the latest rules without touching the data.
create table if not exists public.ads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  owner uuid not null default auth.uid() references auth.users(id) on delete cascade,
  title text not null check (char_length(title) between 2 and 90),
  cat text not null check (char_length(cat) <= 20),
  price bigint not null default 0 check (price >= 0),
  stype text not null default 'person' check (stype in ('factory','shop','person')),
  sale text not null default 'retail' check (sale in ('retail','wholesale','both')),
  city text not null check (char_length(city) <= 20),
  district text not null default '' check (char_length(district) <= 60),
  descr text not null default '' check (char_length(descr) <= 1500),
  name text not null check (char_length(name) between 1 and 60),
  phone text not null check (char_length(phone) between 9 and 16),
  wa boolean not null default true,
  images text[] not null default '{}' check (cardinality(images) <= 3),
  thumb text not null default '',
  sold boolean not null default false
);

-- Photo addresses must point at our own photo storage (blocks HTML/script injection through these fields).
create or replace function public.ad_photo_ok(u text) returns boolean
language sql immutable set search_path = '' as $$
  select u ~ '^https://[a-z0-9]+\.supabase\.co/storage/v1/object/public/ad-photos/[A-Za-z0-9_./-]+$'
         and u !~ '\.\.'
$$;
create or replace function public.ad_photos_ok(a text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(public.ad_photo_ok(x)), true) from unnest(a) as x
$$;
alter table public.ads drop constraint if exists ads_photos_ok;
alter table public.ads add constraint ads_photos_ok
  check (public.ad_photos_ok(images) and (thumb = '' or public.ad_photo_ok(thumb)));

-- Search text (lower-case, Arabic letter variants and half-spaces unified — same rules as norm() in js/utils.js)
-- and a price column for "cheapest first" that puts "negotiable" (0) last.
alter table public.ads add column if not exists search text generated always as (
  translate(lower(title || ' ' || descr || ' ' || name || ' ' || district),
            U&'\064A\0649\0643\06CD\06D0\200C', U&'\06CC\06CC\06A9\06CC\06CC ')
) stored;
alter table public.ads add column if not exists price_n bigint generated always as (nullif(price, 0)) stored;
-- sample listings (added by the site owner while the site is new): shown with a "sample" label, no contact buttons
alter table public.ads add column if not exists sample boolean not null default false;

create extension if not exists pg_trgm with schema extensions;
create index if not exists ads_created_idx on public.ads (created_at desc);
create index if not exists ads_place_idx on public.ads (city, district);
create index if not exists ads_owner_idx on public.ads (owner, created_at desc);
create index if not exists ads_phone_idx on public.ads (phone);
create index if not exists ads_cat_idx on public.ads (cat, created_at desc);
create index if not exists ads_search_idx on public.ads using gin (search extensions.gin_trgm_ops);

-- Site admins: accounts listed here can mark any ad as sold or delete it (moderation).
-- Add an admin in the SQL editor:
--   insert into public.admins (user_id) select id from auth.users where email = 'someone@example.com';
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  added_at timestamptz not null default now()
);
alter table public.admins enable row level security;
drop policy if exists "admins see themselves" on public.admins;
create policy "admins see themselves" on public.admins for select to authenticated using (user_id = auth.uid());
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

-- For posts from the website: the post date is always set by the server (nobody can pin an ad to the top
-- with a future date), and each account can post at most 30 new ads per day (spam limit).
-- Restores run in the SQL editor (not as a website user) and keep their original dates.
create or replace function public.ads_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.sample := false; -- only the site owner (SQL editor) can add sample listings
    if (select count(*) from public.ads a
        where a.owner = new.owner and a.created_at > now() - interval '1 day') >= 30 then
      raise exception 'ad_limit: at most 30 new ads per day' using errcode = 'P0001';
    end if;
  else
    new.created_at := old.created_at;
    new.sample := old.sample;
    new.owner := old.owner; -- an ad always stays with the account that posted it (also when an admin edits it)
  end if;
  return new;
end $$;
drop trigger if exists ads_guard on public.ads;
create trigger ads_guard before insert or update on public.ads
  for each row execute function public.ads_guard();

alter table public.ads enable row level security;
drop policy if exists "ads are public" on public.ads;
drop policy if exists "owner can insert" on public.ads;
drop policy if exists "owner can update" on public.ads;
drop policy if exists "owner can delete" on public.ads;
create policy "ads are public" on public.ads for select using (true);
create policy "owner can insert" on public.ads for insert to authenticated
  with check (owner = auth.uid() and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false);
create policy "owner can update" on public.ads for update to authenticated
  using (owner = auth.uid() or public.is_admin()) with check (owner = auth.uid() or public.is_admin());
create policy "owner can delete" on public.ads for delete to authenticated
  using (owner = auth.uid() or public.is_admin());

-- photo storage (public read, each user writes only in their own folder, at most 400 files per account;
-- admins can also list and delete photos, to clean up after removing an ad)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ad-photos', 'ad-photos', true, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
-- (older names of these rules, from when the project was called Bazarcha)
drop policy if exists "bazarcha upload own" on storage.objects;
drop policy if exists "bazarcha update own" on storage.objects;
drop policy if exists "bazarcha delete own" on storage.objects;
drop policy if exists "bazarcha list own" on storage.objects;
drop policy if exists "maamila upload own" on storage.objects;
drop policy if exists "maamila update own" on storage.objects;
drop policy if exists "maamila delete own" on storage.objects;
drop policy if exists "maamila list own" on storage.objects;
create policy "maamila upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text
              and coalesce((auth.jwt()->>'is_anonymous')::boolean, false) = false
              and (select count(*) from storage.objects o
                   where o.bucket_id = 'ad-photos' and o.name like auth.uid()::text || '/%') < 400);
create policy "maamila update own" on storage.objects for update to authenticated
  using (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "maamila delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'ad-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));
create policy "maamila list own" on storage.objects for select to authenticated
  using (bucket_id = 'ad-photos' and ((storage.foldername(name))[1] = auth.uid()::text or public.is_admin()));

-- Messages from the contact form in the footer. Anyone can send one (logged in or not);
-- only admins can read, mark as handled or delete them.
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sender uuid default auth.uid() references auth.users(id) on delete set null,
  name text not null default '' check (char_length(name) <= 60),
  contact text not null check (char_length(contact) between 5 and 100),
  body text not null check (char_length(body) between 5 and 2000),
  handled boolean not null default false
);
create index if not exists messages_created_idx on public.messages (created_at desc);
-- the admin's reply, sent from info@maamila.com by the Worker (worker/index.js, POST /api/reply)
alter table public.messages add column if not exists reply text check (char_length(reply) <= 5000);
alter table public.messages add column if not exists replied_at timestamptz;
alter table public.messages enable row level security;
drop policy if exists "anyone can send a message" on public.messages;
drop policy if exists "admins read messages" on public.messages;
drop policy if exists "admins update messages" on public.messages;
drop policy if exists "admins delete messages" on public.messages;
create policy "anyone can send a message" on public.messages for insert to anon, authenticated
  with check (handled = false);
create policy "admins read messages" on public.messages for select to authenticated using (public.is_admin());
create policy "admins update messages" on public.messages for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy "admins delete messages" on public.messages for delete to authenticated using (public.is_admin());

-- Spam limits for website visitors: the date is set by the server, at most 3 messages per contact address
-- per hour and at most 60 messages per hour in total. Senders cannot read messages, so the counting runs in a
-- helper with the owner's rights (security definer); the trigger itself runs as the visitor.
create or replace function public.message_counts(c text, out same_contact bigint, out total bigint)
language sql stable security definer set search_path = '' as $$
  select count(*) filter (where lower(m.contact) = lower(c)), count(*)
  from public.messages m where m.created_at > now() - interval '1 hour'
$$;
revoke execute on function public.message_counts(text) from public;
grant execute on function public.message_counts(text) to anon, authenticated;
create or replace function public.messages_guard() returns trigger
language plpgsql set search_path = '' as $$
declare n record;
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;
  new.created_at := now();
  new.handled := false;
  new.sender := auth.uid();
  new.reply := null;
  new.replied_at := null;
  -- a logged-in visitor's message always carries their account's own email (cannot be faked)
  if auth.uid() is not null and coalesce(auth.jwt()->>'email', '') <> '' then
    new.contact := auth.jwt()->>'email';
    new.name := ''; -- shown by their email only, never a typed-in name
  end if;
  select * into n from public.message_counts(new.contact);
  if n.same_contact >= 3 or n.total >= 60 then
    raise exception 'msg_limit: too many messages, try again later' using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists messages_guard on public.messages;
create trigger messages_guard before insert on public.messages
  for each row execute function public.messages_guard();
