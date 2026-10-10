-- tests/integration/bootstrap.sql – simuliert die Supabase-Rollen für PostgREST und spielt die echte Migration ein.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create role authenticator login password 'test' noinherit;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
\i /migrations/20261010000001_orders.sql
grant usage on schema public to authenticator;
