/* VBA (synthetic):
Private Sub Status_BeforeUpdate(Cancel As Integer)
    If IsNull(DLookup("ToStatus", "StatusTransitions", "FromStatus='" & Me.Status.OldValue & "' AND ToStatus='" & Me.Status & "'")) Then
        MsgBox "That status change is not allowed"
        Cancel = True
    End If
End Sub
*/
function handler() {
  const from = String(ctx.record.old?.status);
  const to = String(ctx.record.new?.status);
  if (from === to) return { allowed: true };
  const rows = db.query("select to_status from status_transitions where from_status = $1 and to_status = $2", [from, to]);
  const allowed = rows.length > 0;
  if (!allowed) {
    ui.message("That status change is not allowed");
    ui.cancel("Status change not allowed");
  }
  return { allowed };
}
