/* VBA (synthetic):
Private Sub Form_BeforeInsert(Cancel As Integer)
    Dim owed As Currency, lim As Currency
    owed = Nz(DSum("Total", "Orders", "CustomerID=" & Me.CustomerID & " AND Status='open'"), 0)
    lim = DLookup("CreditLimit", "Customers", "ID=" & Me.CustomerID)
    If owed + Me.Total > lim Then
        MsgBox "Credit limit exceeded"
        Cancel = True
    End If
End Sub
*/
function handler() {
  const r = ctx.record.new ?? {};
  const owed = db.query("select coalesce(sum(total), 0) as owed from orders where customer_id = $1 and status = $2", [Number(r.customer_id), "open"]);
  const lim = db.query("select credit_limit from customers where id = $1", [Number(r.customer_id)]);
  const exceeded = Number(owed[0]?.owed) + Number(r.total) > Number(lim[0]?.credit_limit);
  if (exceeded) {
    ui.message("Credit limit exceeded");
    ui.cancel("Credit limit exceeded");
  }
  return { exceeded };
}
