/* VBA (synthetic):
Public Sub ArchiveOldOrders(days As Integer)
    Dim rs As DAO.Recordset, n As Long
    Set rs = CurrentDb.OpenRecordset("SELECT * FROM Orders WHERE OrderDate < DateAdd('d', -" & days & ", Date()) AND Archived = False")
    Do While Not rs.EOF
        rs.Edit
        rs!Archived = True
        rs.Update
        n = n + 1
        rs.MoveNext
    Loop
    MsgBox n & " orders archived"
End Sub
*/
function handler() {
  const days = Number(ctx.record.new?.days ?? 365);
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const old = db.query("select id from orders where order_date < $1::date and archived = false order by id", [cutoff]);
  let n = 0;
  for (const o of old) {
    db.query("update orders set archived = true where id = $1 returning id", [Number(o.id)]);
    n++;
  }
  ui.message(`${n} orders archived`);
  return { archived: n };
}
