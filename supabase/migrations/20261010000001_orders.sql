-- 20261010000001_orders.sql
-- Bestellsystem für Unique by Lea. NUR gegen eine lokale/separate Entwicklungs- oder Staging-Datenbank ausführen,
-- nie ungeprüft gegen Produktion. Zugriff ausschliesslich serverseitig über den Supabase-Secret-/Service-Key.
-- Alle Tabellen: RLS aktiv, KEINE Policies für anon/authenticated, Tabellenrechte für diese Rollen entzogen.
-- (Der Service-Key umgeht RLS bewusst; er darf nie im Browser landen.)

create extension if not exists pgcrypto;

create sequence if not exists public.order_number_seq start 1001;

create type public.order_status as enum ('awaiting_payment','processing','shipped','completed','cancelled');
create type public.payment_status as enum ('pending','paid','failed','expired','refunded','partially_refunded');
create type public.notification_status as enum ('pending','sent','failed');

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique
    default ('UBL-' || to_char(now() at time zone 'Europe/Zurich','YYYY') || '-' || lpad(nextval('public.order_number_seq')::text, 5, '0')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status public.order_status not null default 'awaiting_payment',
  payment_status public.payment_status not null default 'pending',
  -- Kundendaten (nur das Nötige für Versand und Kontakt)
  customer_email text,
  customer_name text,
  customer_phone text,
  billing_address jsonb,
  shipping_address jsonb,
  shipping_type text not null check (shipping_type in ('bpost','apost','letter','email','pickup')),
  -- Beträge in Rappen (ganzzahlig, keine Rundungsfehler)
  currency char(3) not null default 'CHF' check (currency = 'CHF'),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  shipping_cents integer not null check (shipping_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  tax_cents integer not null default 0 check (tax_cents >= 0), -- 0, solange keine MWST-Pflicht/Ausweisung festgelegt ist
  total_cents integer not null check (total_cents >= 0),
  voucher_code text,
  -- Stripe
  stripe_session_id text unique,
  stripe_session_url text,
  stripe_payment_intent_id text,
  cart_hash text, -- Schutz vor Doppelklick/Doppelbestellung
  -- Zeitstempel
  paid_at timestamptz,
  shipped_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  tracking_number text,
  admin_read_at timestamptz,
  needs_attention text, -- z. B. Betragsabweichung, späte Zahlung
  internal_note text,
  constraint total_consistent check (total_cents = subtotal_cents + shipping_cents - discount_cents)
);
create index orders_created_idx on public.orders (created_at desc);
create index orders_status_idx on public.orders (status, payment_status);
create index orders_cart_hash_idx on public.orders (cart_hash) where payment_status = 'pending';

create table public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete restrict,
  product_id text,
  sku text,
  product_name text not null,         -- historischer Name zum Bestellzeitpunkt
  unit_price_cents integer not null check (unit_price_cents > 0),
  quantity integer not null check (quantity > 0 and quantity <= 99),
  attributes jsonb not null default '{}'::jsonb -- Farbe, Grösse, Wunschname, Gutscheindaten usw.
);
create index order_items_order_idx on public.order_items (order_id);

create table public.order_status_history (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  created_at timestamptz not null default now(),
  kind text not null check (kind in ('order_status','payment_status','note')),
  from_value text,
  to_value text,
  actor text not null, -- 'stripe-webhook', 'checkout', 'admin'
  detail text
);
create index order_status_history_order_idx on public.order_status_history (order_id, created_at);

create table public.payment_events (
  id bigint generated always as identity primary key,
  stripe_event_id text not null unique, -- Idempotenz: jedes Ereignis nur einmal
  order_id uuid references public.orders(id) on delete restrict,
  event_type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  processing_status text not null default 'received' check (processing_status in ('received','processed','ignored','failed')),
  error_detail text -- bereinigt, keine Zahlungsdaten
);
create index payment_events_order_idx on public.payment_events (order_id);

create table public.email_notifications (
  id bigint generated always as identity primary key,
  order_id uuid not null references public.orders(id) on delete restrict,
  kind text not null check (kind in ('operator_new_order','customer_order_confirmation','operator_alert')),
  recipient text not null,
  status public.notification_status not null default 'pending',
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  error_detail text,
  unique (order_id, kind) -- verhindert doppelte Benachrichtigungen bei wiederholten Webhooks
);

create table public.voucher_redemptions (
  id bigint generated always as identity primary key,
  stripe_session_id text not null unique, -- eine Abbuchung pro Bestellung
  order_id uuid references public.orders(id) on delete restrict,
  voucher_code text not null,
  amount_cents integer not null check (amount_cents > 0),
  created_at timestamptz not null default now()
);

-- updated_at automatisch pflegen
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin new.updated_at := now(); return new; end $$;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- Bezahlte Bestellungen dürfen in ihren Beträgen nicht mehr verändert werden
create or replace function public.orders_freeze_amounts() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.payment_status = 'paid' and (
       new.subtotal_cents is distinct from old.subtotal_cents or
       new.shipping_cents is distinct from old.shipping_cents or
       new.discount_cents is distinct from old.discount_cents or
       new.total_cents is distinct from old.total_cents or
       new.currency is distinct from old.currency) then
    raise exception 'Beträge einer bezahlten Bestellung sind unveränderlich';
  end if;
  return new;
end $$;
create trigger orders_freeze before update on public.orders
  for each row execute function public.orders_freeze_amounts();

-- Positionen sind nach dem Anlegen unveränderlich (historische Preise/Namen)
create or replace function public.order_items_immutable() returns trigger
language plpgsql set search_path = public as $$
begin raise exception 'order_items sind unveränderlich'; end $$;
create trigger order_items_no_update before update or delete on public.order_items
  for each row execute function public.order_items_immutable();

-- Row Level Security: aktiv, ohne Policies => anon/authenticated haben keinerlei Zugriff
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.order_status_history enable row level security;
alter table public.payment_events enable row level security;
alter table public.email_notifications enable row level security;
alter table public.voucher_redemptions enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
