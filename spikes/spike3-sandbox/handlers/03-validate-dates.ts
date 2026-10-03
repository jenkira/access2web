/* VBA (synthetic):
Private Sub ShipDate_BeforeUpdate(Cancel As Integer)
    If Not IsNull(Me.ShipDate) Then
        If Me.ShipDate < Me.OrderDate Then
            MsgBox "Ship date cannot be before the order date."
            Cancel = True
        End If
    End If
End Sub
*/
function handler() {
  const r = ctx.record.new ?? {};
  if (r.ship_date == null) return { valid: true };
  const ship = new Date(String(r.ship_date)).getTime();
  const order = new Date(String(r.order_date)).getTime();
  if (ship < order) {
    ui.message("Ship date cannot be before the order date.");
    ui.cancel("Ship date before order date");
    return { valid: false };
  }
  return { valid: true };
}
