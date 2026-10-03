/* VBA (synthetic):
Private Sub Quantity_AfterUpdate()
    Me.LineTotal = Round(Me.Quantity * Me.UnitPrice * (1 - Nz(Me.Discount, 0)), 2)
End Sub
*/
function handler() {
  const r = ctx.record.new ?? {};
  const qty = Number(r.qty ?? 0);
  const price = Number(r.unit_price ?? 0);
  const discount = Number(r.discount ?? 0);
  const total = Math.round(qty * price * (1 - discount) * 100) / 100;
  ui.setValue("line_total", total);
  return { total };
}
