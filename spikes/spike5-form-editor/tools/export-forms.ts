// Write spec/expression/forms.json: the demo forms and the errors each record must produce.
// The expected errors are written by hand below. Both evaluators must reproduce them.
// Run: node --experimental-strip-types --no-warnings tools/export-forms.ts
import { writeFileSync } from "node:fs";
import { demoDefinition } from "../fixtures/demo.ts";

const def = demoDefinition();
type E = { control: string; message: string };
const e = (control: string, message: string): E => ({ control, message });
const NOW = "2026-03-01T09:30:00Z";

const cases: { form: string; record: Record<string, unknown>; errors: E[]; unknown: string[]; note?: string }[] = [
  // ProductForm: a validation rule, a default that does not matter here, and required fields
  { form: "ProductForm", record: { name: "Widget", unit_price: -5 }, errors: [e("p_price", "Price must not be negative")], unknown: [] },
  { form: "ProductForm", record: { unit_price: 1 }, errors: [e("p_name", "Product name is required")], unknown: [] },
  { form: "ProductForm", record: { name: "Widget", unit_price: 5 }, errors: [], unknown: [] },
  { form: "ProductForm", record: {}, errors: [e("p_price", "Price must not be negative"), e("p_name", "Product name is required"), e("p_price", "Unit price is required")], unknown: [], note: "rule errors come first, then required errors, each in control order. A rule on an empty field fails." },
  { form: "ProductForm", record: { name: "x", unit_price: "5" }, errors: [e("p_price", "Price must not be negative")], unknown: [], note: "a number held as text is not a number" },
  { form: "ProductForm", record: { name: "", unit_price: 1 }, errors: [e("p_name", "Product name is required")], unknown: [], note: "an empty string counts as empty" },
  { form: "ProductForm", record: { name: "x", unit_price: 0 }, errors: [], unknown: [], note: "zero is a value" },
  { form: "ProductForm", record: { name: "x", unit_price: 1, hacker: 1, productid: 3 }, errors: [], unknown: ["hacker", "productid"], note: "a key that no control binds is unknown" },
  // CreditReviewForm: a hidden control is not checked
  { form: "CreditReviewForm", record: { name: "A", active: false, credit_limit: 999999 }, errors: [], unknown: [] },
  { form: "CreditReviewForm", record: { name: "A", active: true, credit_limit: 999999 }, errors: [e("v_credit", "Limit is too high")], unknown: [] },
  { form: "CreditReviewForm", record: { name: "A", active: true }, errors: [e("v_credit", "Limit is too high")], unknown: [], note: "a comparison with null is false, so the rule fails" },
  { form: "CreditReviewForm", record: {}, errors: [e("v_name", "Customer is required")], unknown: [] },
  { form: "CreditReviewForm", record: { name: "A", active: true, credit_limit: 100000 }, errors: [], unknown: [], note: "the limit itself is allowed" },
  // OrderForm: conditional visibility, a cross-field rule, and a combo box
  { form: "OrderForm", record: { customer_id: 1, status: "new", order_date: "2026-03-10" }, errors: [], unknown: [] },
  { form: "OrderForm", record: { customer_id: 1, status: "shipped", order_date: "2026-03-10", ship_date: "2026-03-01" }, errors: [e("o_ship", "Ship date cannot be before the order date")], unknown: [] },
  { form: "OrderForm", record: { customer_id: 1, status: "shipped", order_date: "2026-03-10", ship_date: "2026-03-12" }, errors: [], unknown: [] },
  { form: "OrderForm", record: { customer_id: 1, status: "new", order_date: "2026-03-10", ship_date: "2026-03-01" }, errors: [], unknown: [], note: "the ship date control is hidden, so its rule is not checked" },
  { form: "OrderForm", record: { status: "new", order_date: "2026-03-10" }, errors: [e("o_cust", "Customer is required")], unknown: [] },
  { form: "OrderForm", record: { customer_id: 1, status: "", order_date: "" }, errors: [e("o_status", "Status is required"), e("o_date", "Order date is required")], unknown: [] },
  { form: "OrderForm", record: { customer_id: 1, status: "shipped", order_date: "2026-03-10" }, errors: [], unknown: [], note: "an empty ship date passes through isnull" },
  // OrderLineForm: two rules on two controls
  { form: "OrderLineForm", record: { product_id: 1, qty: 5, discount: 0.1 }, errors: [], unknown: [] },
  { form: "OrderLineForm", record: { product_id: 1, qty: 0, discount: 0 }, errors: [e("l_qty", "Quantity must be more than zero")], unknown: [] },
  { form: "OrderLineForm", record: { product_id: 1, qty: 2, discount: 2 }, errors: [e("l_disc", "Discount is between 0 and 1")], unknown: [] },
  { form: "OrderLineForm", record: { product_id: 1, qty: 2 }, errors: [e("l_disc", "Discount is between 0 and 1")], unknown: [] },
  { form: "OrderLineForm", record: {}, errors: [e("l_qty", "Quantity must be more than zero"), e("l_disc", "Discount is between 0 and 1"), e("l_prod", "Product is required"), e("l_qty", "Quantity is required")], unknown: [] },
  { form: "OrderLineForm", record: { product_id: 1, qty: 1, discount: 1, order_id: 7 }, errors: [], unknown: ["order_id"] },
  // CustomerForm: no rules, so only required fields
  { form: "CustomerForm", record: { name: "Ada" }, errors: [], unknown: [] },
  { form: "CustomerForm", record: { city: "Leeds" }, errors: [e("c_name", "Name is required")], unknown: [] },
];

writeFileSync(new URL("../../../spec/expression/forms.json", import.meta.url), JSON.stringify({
  description: "Conformance vectors for server-side form rules. Given a form and a record, both the TypeScript and the Python checker must report these errors, in this order, and these unknown fields. The definition is the demo application from the form editor prototype.",
  now: NOW,
  definition: { app: def.app, version: def.version, entities: def.entities, forms: def.forms },
  cases,
}, null, 1) + "\n");
console.log(`wrote ${cases.length} cases`);
