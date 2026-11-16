-- Bazarcha: database + photo storage setup
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
create index if not exists ads_created_idx on public.ads (created_at desc);
create index if not exists ads_place_idx on public.ads (city, district);

alter table public.ads enable row level security;
drop policy if exists "ads are public" on public.ads;
drop policy if exists "owner can insert" on public.ads;
drop policy if exists "owner can update" on public.ads;
drop policy if exists "owner can delete" on public.ads;
create policy "ads are public" on public.ads for select using (true);
create policy "owner can insert" on public.ads for insert to authenticated with check (owner = auth.uid());
create policy "owner can update" on public.ads for update to authenticated using (owner = auth.uid()) with check (owner = auth.uid());
create policy "owner can delete" on public.ads for delete to authenticated using (owner = auth.uid());

-- photo storage (public read, each user writes only in their own folder)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ad-photos', 'ad-photos', true, 1048576, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;
drop policy if exists "bazarcha upload own" on storage.objects;
drop policy if exists "bazarcha update own" on storage.objects;
drop policy if exists "bazarcha delete own" on storage.objects;
drop policy if exists "bazarcha list own" on storage.objects;
create policy "bazarcha upload own" on storage.objects for insert to authenticated
  with check (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bazarcha update own" on storage.objects for update to authenticated
  using (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bazarcha delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "bazarcha list own" on storage.objects for select to authenticated
  using (bucket_id = 'ad-photos' and (storage.foldername(name))[1] = auth.uid()::text);
