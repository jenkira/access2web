// Database access for the spike. Handlers connect as a login role that belongs to ONE application
// and is a member of no other role, so SQL cannot switch to another application's role.
import pg from "pg";

export const ADMIN = process.env.A2W_SPIKE_ADMIN_URL ?? "postgresql://postgres:test@127.0.0.1:54329/postgres";
export const DB = "a2w_spike3";
const base = ADMIN.replace(/\/[^/]*$/, "");
const creds = { app_a: "app_a_login:a", app_b: "app_b_login:b" };
const pools = new Map();

export function adminUrl() {
  return `${base}/${DB}`;
}

export function pool(app) {
  if (!pools.has(app)) {
    const [user, pw] = creds[app].split(":");
    const u = new URL(base);
    pools.set(app, new pg.Pool({ host: u.hostname, port: Number(u.port), user, password: pw, database: DB, max: 8 }));
  }
  return pools.get(app);
}

export async function closePools() {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

export async function setup() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`drop database if exists ${DB} with (force)`);
  await admin.query(`create database ${DB}`);
  for (const r of ["app_a_login", "app_b_login"]) {
    await admin.query(`drop role if exists ${r}`);
  }
  await admin.end();
  const c = new pg.Client({ connectionString: adminUrl() });
  await c.connect();
  await c.query(`
    create schema app_a; create schema app_b;
    create table app_a.customers (id serial primary key, name text not null, credit_limit numeric not null, status text not null default 'active');
    create table app_a.products (id serial primary key, name text not null, unit_price numeric not null, stock int not null);
    create table app_a.orders (id serial primary key, customer_id int references app_a.customers(id), status text not null default 'new',
                               order_date date not null, ship_date date, total numeric not null default 0, archived boolean not null default false);
    create table app_a.orderlines (id serial primary key, order_id int references app_a.orders(id), product_id int references app_a.products(id),
                                   qty int not null, discount numeric not null default 0, line_total numeric not null default 0);
    create table app_a.status_transitions (from_status text not null, to_status text not null);
    create table app_b.secrets (id serial primary key, value text not null);
    insert into app_b.secrets(value) values ('TOP SECRET OF APP B');
    insert into app_a.customers(name, credit_limit) values ('Acme', 1000), ('Birch', 200), ('Cedar', 50);
    insert into app_a.products(name, unit_price, stock) values ('Widget', 2.50, 100), ('Gadget', 10.00, 20), ('Sprocket', 0.125, 5);
    insert into app_a.orders(customer_id, status, order_date, ship_date, total) values
      (1, 'open', '2025-01-10', null, 250), (1, 'shipped', '2025-02-01', '2025-02-03', 40), (2, 'open', '2024-01-01', null, 190),
      (3, 'open', '2024-03-01', null, 40);
    insert into app_a.orderlines(order_id, product_id, qty, discount, line_total) values
      (1, 1, 10, 0, 25), (1, 2, 5, 0, 50), (2, 2, 4, 0, 40), (3, 2, 19, 0, 190), (4, 2, 4, 0, 40);
    insert into app_a.status_transitions values ('new','open'), ('open','shipped'), ('open','cancelled'), ('shipped','closed');
    create role app_a_login login password 'a' nosuperuser nocreaterole nocreatedb;
    create role app_b_login login password 'b' nosuperuser nocreaterole nocreatedb;
    grant connect on database ${DB} to app_a_login, app_b_login;
    grant usage on schema app_a to app_a_login; grant usage on schema app_b to app_b_login;
    grant select, insert, update, delete on all tables in schema app_a to app_a_login;
    grant usage, select on all sequences in schema app_a to app_a_login;
    grant select, insert, update, delete on all tables in schema app_b to app_b_login;
    alter role app_a_login set search_path = app_a;
    alter role app_b_login set search_path = app_b;
    alter role app_a_login set statement_timeout = '400ms';
    revoke all on schema public from public;
  `);
  await c.end();
}
