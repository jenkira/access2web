/* VBA (synthetic):
Private Sub Form_Current()
    If Me.NewRecord Then
        Me.Status = "new"
        Me.OrderDate = Date
        Me.ShipDate.Visible = False
    Else
        Me.ShipDate.Visible = True
    End If
End Sub
*/
function handler() {
  const isNew = ctx.record.old === undefined;
  if (isNew) {
    ui.setValue("status", "new");
    ui.setValue("order_date", new Date().toISOString().slice(0, 10));
  }
  ui.setVisible("ship_date", !isNew);
  return { isNew };
}
