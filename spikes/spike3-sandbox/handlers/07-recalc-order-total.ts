/* VBA (synthetic):
Public Sub RecalcOrder(orderId As Long)
    Dim rs As DAO.Recordset, total As Currency
    Set rs = CurrentDb.OpenRecordset("SELECT LineTotal FROM OrderLines WHERE OrderID=" & orderId)
    Do While Not rs.EOF
        total = total + rs!LineTotal
        rs.MoveNext
    Loop
    CurrentDb.Execute "UPDATE Orders SET Total=" & total & " WHERE ID=" & orderId
End Sub
*/
function handler() {
  const orderId = Number(ctx.record.new?.id);
  const lines = db.query("select line_total from orderlines where order_id = $1", [orderId]);
  let total = 0;
  for (const line of lines) total += Number(line.line_total);
  db.query("update orders set total = $1 where id = $2 returning id", [total, orderId]);
  return { total, lines: lines.length };
}
