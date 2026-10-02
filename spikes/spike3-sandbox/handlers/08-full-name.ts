/* VBA (synthetic):
Public Function DisplayName(first As Variant, last As Variant) As String
    If IsNull(last) Or last = "" Then
        DisplayName = Nz(first, "")
    ElseIf IsNull(first) Or first = "" Then
        DisplayName = last
    Else
        DisplayName = last & ", " & first
    End If
End Function
*/
function handler() {
  const r = ctx.record.new ?? {};
  const first = r.first_name == null ? "" : String(r.first_name);
  const last = r.last_name == null ? "" : String(r.last_name);
  const name = last === "" ? first : first === "" ? last : `${last}, ${first}`;
  ui.setValue("display_name", name);
  return { name };
}
