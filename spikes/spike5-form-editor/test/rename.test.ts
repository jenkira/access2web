// Rename tests against PostgreSQL. For each case: generate the migration, apply it, and check that
//   1. the data survives,   2. every saved query still runs and returns the same rows and column names,
//   3. every form and rule refers only to fields that exist,   4. handlers that mention the name are listed, none edited.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { SAMPLE_SQL, SCHEMA } from "../fixtures/demo.ts";
import { demoFull } from "../fixtures/node.ts";
import { planRenameEntity, planRenameField, type RenamePlan } from "../src/model/rename.ts";
import { canonical, type Definition } from "../src/model/types.ts";
import { validateDefinition } from "../src/model/validate.ts";

const ADMIN = process.env.A2W_SPIKE_ADMIN_URL ?? "postgresql://postgres:test@127.0.0.1:54329/postgres";
const DB = "a2w_spike5";
let client: pg.Client;

before(async () => {
  const a = new pg.Client({ connectionString: ADMIN });
  await a.connect();
  await a.query(`drop database if exists ${DB} with (force)`);
  await a.query(`create database ${DB}`);
  await a.end();
  client = new pg.Client({ connectionString: ADMIN.replace(/\/[^/]*$/, `/${DB}`) });
  await client.connect();
});
after(async () => { await client.end(); });

async function reset() { await client.query("reset search_path"); await client.query(SAMPLE_SQL); await client.query(`set search_path = ${SCHEMA}`); }

async function snapshot(def: Definition) {
  const tables: Record<string, { cols: string[]; rows: unknown[][] }> = {};
  for (const e of def.entities) {
    const r = await client.query({ text: `select * from "${SCHEMA}"."${e.table}" order by 1`, rowMode: "array" });
    tables[e.name] = { cols: r.fields.map((f) => f.name), rows: r.rows };
  }
  const queries: Record<string, { cols: string[]; rows: unknown[][] }> = {};
  for (const q of def.queries) {
    const r = await client.query({ text: q.sql, rowMode: "array" });
    const rows = r.rows.map((x) => JSON.stringify(x)).sort().map((s) => JSON.parse(s));  // order-insensitive
    queries[q.name] = { cols: r.fields.map((f) => f.name), rows };
  }
  return { tables, queries };
}

interface Case { name: string; plan: (d: Definition) => RenamePlan; handlers: string[]; updatedHas?: string[]; entityFrom?: string }
const field = (entity: string, from: string, to: string, handlers: string[], updatedHas?: string[]): Case =>
  ({ name: `${entity}.${from} -> ${to}`, plan: (d) => planRenameField(d, entity, from, to), handlers, updatedHas });

// Handler lists come from `grep -lw` over the Spike 3 handler files, not from the code under test.
const CASES: Case[] = [
  field("Customer", "name", "full_name", ["08-full-name"], ["form CustomerForm, control c_name", "form OrderForm, control o_cust", "query ActiveCustomers", "query BigCustomers"]),
  field("Customer", "credit_limit", "limit_amount", ["05-credit-check"], ["form CreditReviewForm, control v_credit", "form CreditReviewForm, control v_city", "query BigCustomers"]),
  field("Customer", "active", "is_active", [], ["form CreditReviewForm, control v_credit", "form CreditReviewForm, control v_city", "query ActiveCustomers"]),
  field("Customer", "customerid", "customer_key", [], ["form OrderForm, control o_cust"]),
  field("Customer", "city", "town", [], ["form CustomerForm, control c_city", "query LondonCustomers"]),
  field("Order", "orderid", "order_key", [], ["form OrderForm, control o_lines", "query OrderTotals", "query OpenOrders"]),
  field("Order", "status", "state", ["04-new-order-defaults", "05-credit-check", "09-status-transition"], ["form OrderForm, control o_status", "form OrderForm, control o_ship", "form OrderForm, control o_notes", "query OpenOrders"]),
  field("Order", "order_date", "placed_on", ["03-validate-dates", "04-new-order-defaults", "10-archive-old-orders"], ["form OrderForm, control o_date", "form OrderForm, control o_ship", "query OpenOrders"]),
  field("Order", "customer_id", "cust_id", ["05-credit-check"], ["form OrderForm, control o_cust", "query OrderTotals"]),
  field("OrderLine", "qty", "quantity", ["02-line-total", "06-update-stock"], ["form OrderLineForm, control l_qty", "form OrderForm, control o_lines", "query OrderTotals"]),
  field("OrderLine", "order_id", "parent_order", ["07-recalc-order-total"], ["form OrderForm, control o_lines", "query OrderTotals"]),
  field("OrderLine", "product_id", "item_id", ["06-update-stock"], ["form OrderLineForm, control l_prod", "form OrderForm, control o_lines", "query OrderTotals"]),
  field("Product", "unit_price", "price", ["01-validate-price", "02-line-total"], ["form ProductForm, control p_price", "query OrderTotals"]),
  field("Product", "productid", "product_key", [], ["form OrderLineForm, control l_prod", "query OrderTotals"]),
  field("Product", "name", "title", ["08-full-name"], ["form ProductForm, control p_name", "form OrderLineForm, control l_prod"]),
  { name: "entity Customer -> Client (table customers -> clients)", plan: (d) => planRenameEntity(d, "Customer", "Client", "clients"), handlers: ["05-credit-check"], updatedHas: ["form CustomerForm", "form OrderForm, control o_cust", "query ActiveCustomers", "query LondonCustomers"] },
  { name: "entity OrderLine -> Line (table orderlines -> order_lines)", plan: (d) => planRenameEntity(d, "OrderLine", "Line", "order_lines"), handlers: ["07-recalc-order-total"], updatedHas: ["form OrderLineForm", "form OrderForm, control o_lines", "query OrderTotals"] },
];

for (const c of CASES) {
  test(`rename ${c.name}`, async () => {
    await reset();
    const def = demoFull();
    const before = await snapshot(def);
    const plan = c.plan(def);

    // 3. every form, query, and rule in the new definition is valid
    assert.deepEqual(validateDefinition(plan.def), [], "forms and rules refer to fields that exist");
    assert.deepEqual(plan.queriesToReview, [], "no query needs manual review");
    for (const u of c.updatedHas ?? []) assert.ok(plan.updated.includes(u), `expected update: ${u}\n  got: ${plan.updated.join("; ")}`);

    // negative control: without the rewrite, the old query text fails after the migration
    for (const s of plan.migration) await client.query(s);
    const needed = plan.updated.filter((u) => u.startsWith("query ")).map((u) => u.slice(6));
    for (const q of def.queries.filter((x) => needed.includes(x.name))) {
      await assert.rejects(client.query(q.sql), `the unchanged query ${q.name} should fail after the migration`);
    }

    // 1 and 2. data survives, and every query returns the same rows and the same column names
    const after = await snapshot(plan.def);
    for (const [i, e] of def.entities.entries()) {  // entity order is unchanged, so the same position is the same entity
      const renamed = plan.def.entities[i]!;
      assert.deepEqual(after.tables[renamed.name]!.rows, before.tables[e.name]!.rows, `data of ${e.name} is unchanged`);
    }
    for (const q of def.queries) assert.deepEqual(after.queries[q.name], before.queries[q.name], `query ${q.name} returns the same rows and column names`);

    // 4. handlers are listed, never edited
    assert.deepEqual(plan.handlersToReview.map((h) => h.handler).sort(), [...c.handlers].sort(), "handlers to review");
    assert.equal(canonical(plan.def.handlers), canonical(def.handlers), "handler source is untouched");
  });
}

test("the migration changes only the column that was renamed", async () => {
  await reset();
  const def = demoFull();
  const plan = planRenameField(def, "Order", "status", "state");
  await client.query(plan.migration[0]!);
  const r = await client.query(`select column_name from information_schema.columns where table_schema = $1 and table_name = 'orders' order by ordinal_position`, [SCHEMA]);
  assert.deepEqual(r.rows.map((x) => x.column_name), ["orderid", "customer_id", "state", "order_date", "ship_date", "freight", "notes"]);
});

test("a primary key and a foreign key survive a rename", async () => {
  await reset();
  const def = demoFull();
  const plan = planRenameField(def, "Customer", "customerid", "customer_key");
  await client.query(plan.migration[0]!);
  await assert.rejects(client.query(`insert into orders(customer_id, status, order_date) values (999, 'x', '2026-01-01')`), /foreign key/);
  await assert.rejects(client.query(`insert into customers(customer_key, name) values (1, 'dup')`), /duplicate key/);
});
