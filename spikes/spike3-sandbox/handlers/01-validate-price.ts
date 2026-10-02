/* VBA (synthetic):
Private Sub Form_BeforeUpdate(Cancel As Integer)
    If Me.UnitPrice < 0 Then
        MsgBox "Price must not be negative"
        Cancel = True
    End If
End Sub
*/
function handler() {
  const price = Number(ctx.record.new?.unit_price);
  if (price < 0) {
    ui.message("Price must not be negative");
    ui.cancel("Negative price");
    return { valid: false };
  }
  return { valid: true };
}
