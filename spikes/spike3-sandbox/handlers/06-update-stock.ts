/* VBA (synthetic):
Private Sub Form_AfterInsert()
    Dim rs As DAO.Recordset
    Set rs = CurrentDb.OpenRecordset("SELECT * FROM Products WHERE ID=" & Me.ProductID)
    rs.Edit
    rs!Stock = rs!Stock - Me.Qty
    rs.Update
    rs.Close
End Sub
*/
function handler() {
  const r = ctx.record.new ?? {};
  const updated = db.query("update products set stock = stock - $1 where id = $2 and stock >= $1 returning id, stock", [Number(r.qty), Number(r.product_id)]);
  if (updated.length === 0) {
    ui.message("Not enough stock");
    ui.cancel("Insufficient stock");
    return { ok: false };
  }
  return { ok: true, stock: Number(updated[0]?.stock) };
}
