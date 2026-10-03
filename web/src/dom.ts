// Build elements with textContent only, so user-entered data is never parsed as HTML.
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function show(root: HTMLElement, ...nodes: Node[]): void {
  root.replaceChildren(...nodes);
}

export function errorBox(message: string): HTMLElement {
  return el("p", { class: "error", role: "alert" }, message);
}
