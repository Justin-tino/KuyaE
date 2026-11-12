-- ============================================================================
-- Kuya E Tapsilogan POS - Supabase database setup
-- ----------------------------------------------------------------------------
-- HOW TO USE:
--   1. Open your Supabase project.
--   2. Go to "SQL Editor" in the left menu.
--   3. Paste this ENTIRE file and click "Run".
--   4. That's it. Everything (tables, security, realtime, storage bucket) is
--      created. It is safe to run more than once.
--
-- NOTE ON SECURITY:
--   The POS server talks to the database with the "service_role" key, so all
--   tables have Row Level Security ENABLED with NO policies. That means the
--   public "anon" key cannot read or write anything at all. Only our Node.js
--   server (which also enforces who can do what) has access.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helper: keep updated_at columns fresh
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Users (staff accounts: admin, cashier, kitchen)
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  full_name text not null,
  role text not null check (role in ('admin', 'cashier', 'kitchen')),
  password_hash text not null,
  is_active boolean not null default true,
  last_login_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Sessions (login sessions; the browser only stores a random token)
-- ---------------------------------------------------------------------------
create table if not exists public.sessions (
  token_hash text primary key,
  user_id uuid not null constraint sessions_user_id_fkey references public.users (id) on delete cascade,
  user_agent text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_expires_at_idx on public.sessions (expires_at);
create index if not exists sessions_user_id_idx on public.sessions (user_id);

-- ---------------------------------------------------------------------------
-- Settings (single row: restaurant details shown on receipts and reports)
-- ---------------------------------------------------------------------------
create table if not exists public.settings (
  id integer primary key default 1 check (id = 1),
  restaurant_name text not null default 'Kuya E Tapsilogan',
  address text not null default '',
  phone text not null default '',
  receipt_footer text not null default 'Thank you, come again!',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- Menu items (each item can have a photo stored in the "menus" storage bucket)
-- ---------------------------------------------------------------------------
create table if not exists public.menu_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text not null default '',
  category text not null default 'Meals',
  price numeric(10, 2) not null check (price >= 0),
  image_path text,
  image_url text,
  is_available boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists menu_items_category_idx on public.menu_items (category);

-- ---------------------------------------------------------------------------
-- Orders
--   status:         pending (waiting) -> preparing (cooking) -> served | cancelled
--   payment_status: pending (unpaid) | paid
--   order_number is a sequential number used for first-come-first-served.
-- ---------------------------------------------------------------------------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number integer generated always as identity (start with 1 increment by 1),
  customer_name text not null,
  order_type text not null check (order_type in ('dine_in', 'take_out')),
  notes text,
  status text not null default 'pending' check (status in ('pending', 'preparing', 'served', 'cancelled')),
  payment_status text not null default 'pending' check (payment_status in ('pending', 'paid')),
  payment_method text check (payment_method in ('cash', 'online')),
  subtotal numeric(10, 2) not null default 0,
  total numeric(10, 2) not null default 0,
  cash_received numeric(10, 2),
  change_amount numeric(10, 2),
  reference_number text,
  cancel_reason text,
  created_by uuid constraint orders_created_by_fkey references public.users (id) on delete set null,
  served_by uuid constraint orders_served_by_fkey references public.users (id) on delete set null,
  paid_by uuid constraint orders_paid_by_fkey references public.users (id) on delete set null,
  cancelled_by uuid constraint orders_cancelled_by_fkey references public.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  served_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz
);
create unique index if not exists orders_order_number_key on public.orders (order_number);
create index if not exists orders_created_at_idx on public.orders (created_at desc);
create index if not exists orders_status_idx on public.orders (status);
create index if not exists orders_payment_status_idx on public.orders (payment_status);

-- ---------------------------------------------------------------------------
-- Order items (name and price are copied here so old receipts never change)
-- ---------------------------------------------------------------------------
create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null constraint order_items_order_id_fkey references public.orders (id) on delete cascade,
  menu_item_id uuid constraint order_items_menu_item_id_fkey references public.menu_items (id) on delete set null,
  item_name text not null,
  unit_price numeric(10, 2) not null,
  quantity integer not null check (quantity > 0),
  line_total numeric(10, 2) not null,
  line_no integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_id_idx on public.order_items (order_id);

-- ---------------------------------------------------------------------------
-- Audit logs (who did what, when - shown in the admin Audit Logs page)
-- ---------------------------------------------------------------------------
create table if not exists public.audit_logs (
  id bigint generated always as identity primary key,
  user_id uuid,
  username text,
  action text not null,
  entity text,
  entity_id text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index if not exists audit_logs_created_at_idx on public.audit_logs (created_at desc);
create index if not exists audit_logs_action_idx on public.audit_logs (action);

-- ---------------------------------------------------------------------------
-- Triggers: updated_at
-- ---------------------------------------------------------------------------
drop trigger if exists users_updated_at on public.users;
create trigger users_updated_at before update on public.users
for each row execute function public.set_updated_at();

drop trigger if exists menu_items_updated_at on public.menu_items;
create trigger menu_items_updated_at before update on public.menu_items
for each row execute function public.set_updated_at();

drop trigger if exists orders_updated_at on public.orders;
create trigger orders_updated_at before update on public.orders
for each row execute function public.set_updated_at();

drop trigger if exists settings_updated_at on public.settings;
create trigger settings_updated_at before update on public.settings
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Atomic order creation
--   Creates the order and its items in a single transaction. Prices and
--   totals are always taken from the menu table (never trusted from the
--   browser) and payment rules are validated here as well.
-- ---------------------------------------------------------------------------
create or replace function public.create_pos_order(
  p_customer_name text,
  p_order_type text,
  p_notes text,
  p_items jsonb,
  p_payment_status text,
  p_payment_method text,
  p_cash_received numeric,
  p_reference text,
  p_created_by uuid,
  p_auto_name text
)
returns public.orders
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order public.orders;
  v_menu public.menu_items;
  v_item jsonb;
  v_qty integer;
  v_subtotal numeric(12, 2) := 0;
  v_name text;
  v_method text := null;
  v_cash numeric(12, 2) := null;
  v_change numeric(12, 2) := null;
begin
  if p_order_type is null or p_order_type not in ('dine_in', 'take_out') then
    raise exception 'Invalid order type';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Please add at least one menu item';
  end if;

  if jsonb_array_length(p_items) > 100 then
    raise exception 'Too many items in one order';
  end if;

  if p_payment_status is null or p_payment_status not in ('pending', 'paid') then
    raise exception 'Invalid payment status';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_qty := coalesce((v_item ->> 'quantity')::integer, 0);
    if v_qty < 1 or v_qty > 99 then
      raise exception 'Invalid quantity';
    end if;

    select * into v_menu from menu_items where id = (v_item ->> 'menu_item_id')::uuid;
    if not found then
      raise exception 'A menu item in this order no longer exists';
    end if;
    if not v_menu.is_available then
      raise exception 'Item "%" is not available right now', v_menu.name;
    end if;

    v_subtotal := v_subtotal + (v_menu.price * v_qty);
  end loop;

  if p_payment_status = 'paid' then
    if p_payment_method = 'cash' then
      if p_cash_received is null then
        raise exception 'Enter the cash received from the customer';
      end if;
      if p_cash_received < v_subtotal then
        raise exception 'Cash received is less than the total';
      end if;
      v_method := 'cash';
      v_cash := round(p_cash_received, 2);
      v_change := v_cash - v_subtotal;
    elsif p_payment_method = 'online' then
      v_method := 'online';
      v_cash := v_subtotal;
      v_change := 0;
    else
      raise exception 'Choose a payment method';
    end if;
  end if;

  v_name := nullif(btrim(coalesce(p_customer_name, '')), '');
  if v_name is null then
    v_name := coalesce(nullif(btrim(coalesce(p_auto_name, '')), ''), 'Customer');
  end if;
  if length(v_name) > 80 then
    v_name := left(v_name, 80);
  end if;

  insert into orders (
    customer_name, order_type, notes, status, payment_status, payment_method,
    subtotal, total, cash_received, change_amount, reference_number,
    created_by, paid_by, paid_at
  ) values (
    v_name,
    p_order_type,
    nullif(btrim(coalesce(p_notes, '')), ''),
    'pending',
    p_payment_status,
    v_method,
    v_subtotal,
    v_subtotal,
    v_cash,
    v_change,
    nullif(btrim(coalesce(p_reference, '')), ''),
    p_created_by,
    case when p_payment_status = 'paid' then p_created_by else null end,
    case when p_payment_status = 'paid' then now() else null end
  )
  returning * into v_order;

  insert into order_items (order_id, menu_item_id, item_name, unit_price, quantity, line_total, line_no)
  select
    v_order.id,
    m.id,
    m.name,
    m.price,
    (elem.item ->> 'quantity')::integer,
    (m.price * (elem.item ->> 'quantity')::integer),
    elem.pos::integer
  from jsonb_array_elements(p_items) with ordinality as elem (item, pos)
  join menu_items m on m.id = (elem.item ->> 'menu_item_id')::uuid;

  return v_order;
end;
$$;

-- Only the server (service_role) may call this function.
revoke execute on function public.create_pos_order(text, text, text, jsonb, text, text, numeric, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.create_pos_order(text, text, text, jsonb, text, text, numeric, text, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Lock everything down: RLS on, zero policies (service_role bypasses RLS).
-- ---------------------------------------------------------------------------
alter table public.users enable row level security;
alter table public.sessions enable row level security;
alter table public.settings enable row level security;
alter table public.menu_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;
alter table public.audit_logs enable row level security;

-- ---------------------------------------------------------------------------
-- Realtime: publish the tables so the POS gets instant updates.
-- (Safe to run again; already-added tables are skipped.)
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array['orders', 'order_items', 'menu_items', 'users', 'settings', 'audit_logs']
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Storage bucket for menu photos (public read, server-only write).
-- Uses the "menus" bucket. If it already exists it is updated in place.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'menus',
  'menus',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

-- ============================================================================
-- DONE.
-- Next steps:
--   1. Project Settings > API > copy "Project URL" and "service_role" key.
--   2. Put them in your .env file (local) or in the Render environment.
--   3. Open the app and create the first admin account.
-- ============================================================================
