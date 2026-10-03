// Validation for the browser instructions a handler can emit. Both sandbox hosts use it.
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function applyUi(ui, L, op, a, b) {
  if (ui.length >= L.maxUi) throw new Error("too many ui instructions");
  const str = (v, n) => { if (typeof v !== "string" || v.length > n) throw new Error(`expected a string of at most ${n} characters`); return v; };
  if (op === "message") ui.push({ op, text: str(a, 1000) });
  else if (op === "setVisible") {
    if (typeof b !== "boolean" || !NAME.test(str(a, 64))) throw new Error("setVisible needs a control name and a boolean");
    ui.push({ op, control: a, value: b });
  } else if (op === "setValue") {
    if (!NAME.test(str(a, 64)) || !(b === null || ["string", "number", "boolean"].includes(typeof b))) throw new Error("setValue needs a field name and a plain value");
    if (typeof b === "string" && b.length > 1000) throw new Error("value is too long");
    ui.push({ op, field: a, value: b });
  } else if (op === "cancel") ui.push({ op, reason: str(a, 1000) });
  else throw new Error("unknown ui operation");
}
