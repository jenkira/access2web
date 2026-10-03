// Synthetic application for Spike 5. It stands in for the five forms Spike 1 would export from real databases.
import type { Control, Definition, Entity, Form } from "../src/model/types.ts";

export const SCHEMA = "app_demo";

export const entities: Entity[] = [
  { name: "Customer", table: "customers", fields: [
    { name: "customerid", type: "number", key: true, required: true }, { name: "name", type: "text", required: true },
    { name: "city", type: "text" }, { name: "credit_limit", type: "number" }, { name: "active", type: "bool" }, { name: "joined", type: "date" } ] },
  { name: "Product", table: "products", fields: [
    { name: "productid", type: "number", key: true, required: true }, { name: "name", type: "text", required: true },
    { name: "category", type: "text" }, { name: "unit_price", type: "number", required: true }, { name: "discontinued", type: "bool" } ] },
  { name: "Order", table: "orders", fields: [
    { name: "orderid", type: "number", key: true, required: true }, { name: "customer_id", type: "number", required: true },
    { name: "status", type: "text", required: true }, { name: "order_date", type: "date", required: true },
    { name: "ship_date", type: "date" }, { name: "freight", type: "number" }, { name: "notes", type: "text" } ] },
  { name: "OrderLine", table: "orderlines", fields: [
    { name: "lineid", type: "number", key: true, required: true }, { name: "order_id", type: "number", required: true },
    { name: "product_id", type: "number", required: true }, { name: "qty", type: "number", required: true }, { name: "discount", type: "number" } ] },
];

const text = (id: string, bind: string, label: string, extra: Partial<Control> = {}): Control => ({ id, type: "text", bind, label, ...extra } as Control);
const num = (id: string, bind: string, label: string, extra: Partial<Control> = {}): Control => ({ id, type: "number", bind, label, ...extra } as Control);
const date = (id: string, bind: string, label: string, extra: Partial<Control> = {}): Control => ({ id, type: "date", bind, label, ...extra } as Control);
const check = (id: string, bind: string, label: string, extra: Partial<Control> = {}): Control => ({ id, type: "checkbox", bind, label, ...extra } as Control);
const row = (id: string, ...controls: Control[]) => ({ id, controls });

export const forms: Form[] = [
  // 1. A simple form.
  { name: "CustomerForm", title: "Customer", entity: "Customer", rows: [
    row("r1", text("c_name", "name", "Name")),
    row("r2", text("c_city", "city", "City"), date("c_joined", "joined", "Joined")),
    row("r3", num("c_credit", "credit_limit", "Credit limit"), check("c_active", "active", "Active")),
    row("r4", { id: "c_save", type: "button", label: "Save" } as Control),
  ] },
  // 2. Validation and defaults.
  { name: "ProductForm", title: "Product", entity: "Product", rows: [
    row("r1", text("p_name", "name", "Product name")),
    row("r2", text("p_cat", "category", "Category")),
    row("r3", num("p_price", "unit_price", "Unit price", { validate: [{ expr: "unit_price >= 0", message: "Price must not be negative" }], default: "0" })),
    row("r4", check("p_disc", "discontinued", "Discontinued", { default: "false" })),
  ] },
  // 3. A combo box bound to another table, a subform, and conditional visibility.
  { name: "OrderForm", title: "Order", entity: "Order", rows: [
    row("r1", { id: "o_cust", type: "combo", bind: "customer_id", label: "Customer", source: { entity: "Customer", value: "customerid", display: "name" } } as Control),
    row("r2", text("o_status", "status", "Status", { default: "'new'" }), date("o_date", "order_date", "Order date", { default: "today()" })),
    row("r3", date("o_ship", "ship_date", "Ship date", { visible: "status == 'shipped'", validate: [{ expr: "isnull(ship_date) || ship_date >= order_date", message: "Ship date cannot be before the order date" }] })),
    row("r4", text("o_notes", "notes", "Notes", { visible: "!isnull(notes) || status == 'open'" })),
    row("r5", { id: "o_lines", type: "subform", label: "Lines", child: { entity: "OrderLine", link: "order_id", parentKey: "orderid" }, columns: ["product_id", "qty", "discount"] } as Control),
  ] },
  // 4. A form with a combo and a cross-field rule.
  { name: "OrderLineForm", title: "Order line", entity: "OrderLine", rows: [
    row("r1", { id: "l_prod", type: "combo", bind: "product_id", label: "Product", source: { entity: "Product", value: "productid", display: "name" } } as Control),
    row("r2", num("l_qty", "qty", "Quantity", { validate: [{ expr: "qty > 0", message: "Quantity must be more than zero" }] }), num("l_disc", "discount", "Discount", { default: "0", validate: [{ expr: "discount >= 0 && discount <= 1", message: "Discount is between 0 and 1" }] })),
  ] },
  // 5. Conditional visibility driven by two fields.
  { name: "CreditReviewForm", title: "Credit review", entity: "Customer", rows: [
    row("r1", text("v_name", "name", "Customer")),
    row("r2", check("v_active", "active", "Active")),
    row("r3", num("v_credit", "credit_limit", "Credit limit", { visible: "active", validate: [{ expr: "credit_limit <= 100000", message: "Limit is too high" }] })),
    row("r4", text("v_city", "city", "City", { visible: "active && credit_limit > 1000" })),
  ] },
];

export const queries = [
  { name: "ActiveCustomers", sql: 'select "customerid", "name", "city" from "customers" where "active" = true order by "name"' },
  { name: "OrderTotals", sql: 'select o."orderid", o."customer_id", sum(l."qty" * p."unit_price") as total from "orders" o join "orderlines" l on l."order_id" = o."orderid" join "products" p on p."productid" = l."product_id" group by o."orderid", o."customer_id"' },
  { name: "BigCustomers", sql: 'select c."name", c."credit_limit" from "customers" as c where c."credit_limit" > 1000 order by c."credit_limit" desc' },
  { name: "LondonCustomers", sql: 'select "name", "city" from "customers" where "city" = \'London\'' },
  { name: "OpenOrders", sql: 'select "orderid", "status", "order_date" from "orders" where "status" = \'open\' order by "order_date"' },
];

export function demoDefinition(handlers: Definition["handlers"] = []): Definition {
  return { app: "demo", version: 1, entities: structuredClone(entities), forms: structuredClone(forms), queries: structuredClone(queries), handlers: structuredClone(handlers) };
}

/** A form with n controls, for the render-time measure. */
export function bigForm(n: number): Form {
  const rows = [];
  for (let i = 0; i < n; i += 2) {
    rows.push({ id: `r${i}`, controls: [
      { id: `t${i}`, type: "text", bind: "name", label: `Field ${i}` } as Control,
      ...(i + 1 < n ? [{ id: `t${i + 1}`, type: "number", bind: "credit_limit", label: `Field ${i + 1}`, visible: "active || !active", validate: [{ expr: "credit_limit >= 0", message: "Must not be negative" }] } as Control] : []),
    ] });
  }
  return { name: "BigForm", title: "Big form", entity: "Customer", rows };
}

export const SAMPLE_SQL = `
drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}; set search_path = ${SCHEMA};
create table customers (customerid serial primary key, name text not null, city text, credit_limit numeric, active boolean, joined date);
create table products (productid serial primary key, name text not null, category text, unit_price numeric not null, discontinued boolean);
create table orders (orderid serial primary key, customer_id int references customers(customerid), status text not null, order_date date not null, ship_date date, freight numeric, notes text);
create table orderlines (lineid serial primary key, order_id int references orders(orderid), product_id int references products(productid), qty int not null, discount numeric);
insert into customers(name, city, credit_limit, active, joined) values ('Acme','London',5000,true,'2024-01-15'),('Birch','Leeds',500,true,'2024-03-02'),('Cedar','London',0,false,'2025-06-30'),('Delta',null,2500.5,true,null);
insert into products(name, category, unit_price, discontinued) values ('Widget','Hardware',2.5,false),('Gadget','Hardware',10,false),('Manual','Books',15.75,true);
insert into orders(customer_id, status, order_date, ship_date, freight, notes) values (1,'open','2026-01-10',null,3.5,'rush'),(1,'shipped','2026-02-01','2026-02-03',2.5,null),(2,'open','2026-01-20',null,0.5,null),(4,'new','2026-03-01',null,null,null);
insert into orderlines(order_id, product_id, qty, discount) values (1,1,10,0),(1,2,5,0.1),(2,2,4,0),(3,3,2,0.25),(4,1,1,null);
`;

/** Rows for combo boxes and subforms in the browser preview. The values match SAMPLE_SQL. */
export const sampleLookups = {
  Customer: [{ customerid: 1, name: "Acme", city: "London", credit_limit: 5000, active: true }, { customerid: 2, name: "Birch", city: "Leeds", credit_limit: 500, active: true }, { customerid: 3, name: "Cedar", city: "London", credit_limit: 0, active: false }],
  Product: [{ productid: 1, name: "Widget" }, { productid: 2, name: "Gadget" }, { productid: 3, name: "Manual" }],
  OrderLine: [{ lineid: 1, order_id: 1, product_id: 1, qty: 10, discount: 0 }, { lineid: 2, order_id: 1, product_id: 2, qty: 5, discount: 0.1 }, { lineid: 3, order_id: 2, product_id: 2, qty: 4, discount: 0 }],
} as Record<string, Record<string, string | number | boolean | null>[]>;
