-- tests/db/rls.test.sql – läuft NUR gegen eine lokale Wegwerf-Datenbank (siehe tests/db/run.ps1).
-- Simuliert die Supabase-Rollen und prüft Migration, Constraints, Trigger und Zugriffsrechte.
\set ON_ERROR_STOP on
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
\i /migrations/20261010000001_orders.sql

create temp table results(name text, ok boolean);
create or replace function pg_temp.expect_error(name text, stmt text, as_role text) returns void language plpgsql as $$
begin
  execute format('set local role %I', as_role);
  begin execute stmt; insert into results values (name, false);
  exception when others then insert into results values (name, true);
  end;
  reset role;
end $$;
grant all on results to public;

-- Daten als service_role (Server)
set role service_role;
insert into orders (id, shipping_type, subtotal_cents, shipping_cents, discount_cents, total_cents, customer_email)
 values ('00000000-0000-0000-0000-000000000001','bpost', 5000, 700, 0, 5700, 'kunde@example.com');
insert into order_items (order_id, product_name, unit_price_cents, quantity) values ('00000000-0000-0000-0000-000000000001','Testprodukt',5000,1);
insert into results select 'service_role kann lesen', count(*)=1 from orders;
insert into results select 'Bestellnummer vergeben (UBL-JJJJ-NNNNN)', order_number ~ '^UBL-[0-9]{4}-[0-9]{5}$' from orders;
reset role;

select pg_temp.expect_error('anon darf orders NICHT lesen', 'select * from orders', 'anon');
select pg_temp.expect_error('authenticated darf orders NICHT lesen', 'select * from orders', 'authenticated');
select pg_temp.expect_error('anon darf order_items NICHT lesen', 'select * from order_items', 'anon');
select pg_temp.expect_error('anon darf email_notifications NICHT lesen', 'select * from email_notifications', 'anon');
select pg_temp.expect_error('anon darf payment_events NICHT schreiben', $$insert into payment_events(stripe_event_id,event_type) values ('evt_x','x')$$, 'anon');
select pg_temp.expect_error('authenticated darf Bestellung NICHT schreiben', $$insert into orders(shipping_type,subtotal_cents,shipping_cents,total_cents) values ('bpost',1,0,1)$$, 'authenticated');
select pg_temp.expect_error('authenticated darf Bestellung NICHT löschen', 'delete from orders', 'authenticated');

-- RLS zusätzlich unabhängig von Tabellenrechten: auch mit GRANT bleibt ohne Policy alles leer
grant select on orders to anon;
set role anon; insert into results select 'anon sieht mit GRANT aber ohne Policy 0 Zeilen (RLS greift)', count(*)=0 from orders; reset role;
revoke select on orders from anon;

select pg_temp.expect_error('Summe muss konsistent sein', $$insert into orders(shipping_type,subtotal_cents,shipping_cents,discount_cents,total_cents) values ('bpost',1000,0,0,999)$$, 'service_role');
select pg_temp.expect_error('negative Beträge verboten', $$insert into orders(shipping_type,subtotal_cents,shipping_cents,total_cents) values ('bpost',-1,0,-1)$$, 'service_role');
select pg_temp.expect_error('ungültige Versandart verboten', $$insert into orders(shipping_type,subtotal_cents,shipping_cents,total_cents) values ('ufo',1,0,1)$$, 'service_role');
select pg_temp.expect_error('order_items unveränderlich (update)', $$update order_items set unit_price_cents = 1$$, 'service_role');
select pg_temp.expect_error('Stripe-Event-ID eindeutig', $$insert into payment_events(stripe_event_id,event_type) values ('evt_1','a'),('evt_1','a')$$, 'service_role');
select pg_temp.expect_error('Doppelte Benachrichtigung pro Bestellung+Art verboten', $$insert into email_notifications(order_id,kind,recipient) values ('00000000-0000-0000-0000-000000000001','operator_new_order','a@b.ch'),('00000000-0000-0000-0000-000000000001','operator_new_order','a@b.ch')$$, 'service_role');
select pg_temp.expect_error('Gutschein nur einmal pro Stripe-Session abbuchen', $$insert into voucher_redemptions(stripe_session_id,voucher_code,amount_cents) values ('cs_1','X',100),('cs_1','X',100)$$, 'service_role');
select pg_temp.expect_error('Stripe-Session-ID eindeutig', $$insert into orders(stripe_session_id,shipping_type,subtotal_cents,shipping_cents,total_cents) values ('cs_dup','bpost',1,0,1),('cs_dup','bpost',1,0,1)$$, 'service_role');

-- Bezahlte Beträge eingefroren
set role service_role;
update orders set payment_status='paid', paid_at=now() where id='00000000-0000-0000-0000-000000000001';
reset role;
select pg_temp.expect_error('Betrag einer bezahlten Bestellung unveränderlich', $$update orders set subtotal_cents=1,total_cents=701 where id='00000000-0000-0000-0000-000000000001'$$, 'service_role');
set role service_role;
update orders set status='shipped', tracking_number='X1' where id='00000000-0000-0000-0000-000000000001';
insert into results select 'Statuswechsel einer bezahlten Bestellung erlaubt', status='shipped' from orders where id='00000000-0000-0000-0000-000000000001';
reset role;

select case when ok then 'OK   ' else 'FAIL ' end || name as ergebnis from results order by ok, name;
select count(*) filter (where ok) || '/' || count(*) || ' bestanden' as summe from results;
do $$ begin if exists (select 1 from results where not ok) then raise exception 'DB-Tests fehlgeschlagen'; end if; end $$;
