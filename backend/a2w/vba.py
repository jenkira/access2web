"""VBA inventory and classification. Works on exported source text and never runs it."""
import re
from dataclasses import dataclass, field

STANDARD = "standard_pattern"
TRANSLATABLE = "translatable_logic"
MANUAL = "manual_redesign"

_PROC = re.compile(
    r"^\s*(?:(?:Public|Private|Friend)\s+)?(?:Static\s+)?(Sub|Function|Property\s+(?:Get|Let|Set))\s+(\w+)",
    re.I,
)
_END = re.compile(r"^\s*End\s+(Sub|Function|Property)\b", re.I)
# An event procedure is named Control_Event, for example cmdSave_Click or Form_Load.
_EVENT = re.compile(r"^(\w+?)_(Click|DblClick|Load|Open|Close|Current|BeforeUpdate|AfterUpdate|"
                    r"Change|GotFocus|LostFocus|Enter|Exit|Activate|Format|Print|NoData)$", re.I)

# Rules that force manual redesign, with the reason and a suggested alternative.
_MANUAL_RULES: list[tuple[re.Pattern, str, str]] = [
    (re.compile(r"\bCreateObject\s*\(|\bGetObject\s*\(|\bNew\s+(Excel|Word|Outlook)\.", re.I),
     "automates another desktop program", "Use a server-side integration or an export feature."),
    (re.compile(r"\bDeclare\s+(PtrSafe\s+)?(Function|Sub)\b", re.I),
     "calls a Windows API", "Replace with a server-side library, or remove the dependency."),
    (re.compile(r"\bOpen\s+.+\s+For\s+(Input|Output|Append|Binary|Random)\b|\bKill\s|\bFileCopy\b|"
                r"\bMkDir\b|\bRmDir\b|\bDir\s*\(|\bFileSystemObject\b|\bShell\s*\(", re.I),
     "uses the local file system or runs programs", "Use object storage and a server-side export."),
    (re.compile(r"\bDoCmd\.(PrintOut|OutputTo|TransferSpreadsheet|TransferText|SendObject)\b|"
                r"\bPrinter\b|\bApplication\.(FileDialog|Run)\b", re.I),
     "uses local printing, file export, or e-mail", "Use the report PDF export or a server-side mail integration."),
    (re.compile(r"\bCurrentDb\.Execute\b.*\bIN\s+'|\bODBC;|\bOpenDatabase\s*\(|\bDBEngine\b|\bTransferDatabase\b", re.I),
     "connects to another database", "Model the other source as an integration."),
]

# Rules for standard patterns that map directly to declarative rules.
_STANDARD_STMT = re.compile(
    r"^\s*(?:"
    r"DoCmd\.(OpenForm|OpenReport|Close|Requery|GoToRecord|Save|RunSavedQuery|OpenQuery)\b.*|"
    r"Me\.Requery|Me\.Refresh|"
    r"(?:Me\.)?\w+\.(Visible|Enabled|Locked|Caption|DefaultValue)\s*=\s*.+|"
    r"MsgBox\b.*|"
    r"Exit\s+(Sub|Function)|"
    r"End\s+(Sub|Function|Property)|"
    r"On\s+Error\b.*|"
    r"Option\s+\w+.*|Dim\s+.*|'.*|Rem\b.*|"
    r"(?:Private|Public|Friend)?\s*(?:Sub|Function)\s+\w+.*|"
    r"Cancel\s*=\s*True"
    r")\s*$",
    re.I,
)


@dataclass
class Procedure:
    module: str
    name: str
    kind: str
    line: int
    source: str
    belongs_to: str | None = None
    vba_class: str = TRANSLATABLE
    reason: str = ""
    suggestion: str | None = None
    calls: list[str] = field(default_factory=list)


def parse_module(module: str, source: str) -> list[Procedure]:
    procs: list[Procedure] = []
    cur: Procedure | None = None
    lines: list[str] = []
    for i, raw in enumerate(source.splitlines(), 1):
        line = raw.rstrip()
        m = _PROC.match(line)
        if m and cur is None:
            cur = Procedure(module=module, name=m.group(2), kind=m.group(1).split()[0].title(), line=i, source="")
            ev = _EVENT.match(cur.name)
            if ev:
                cur.belongs_to = ev.group(1)
            lines = [line]
            continue
        if cur is not None:
            lines.append(line)
            if _END.match(line):
                cur.source = "\n".join(lines)
                procs.append(cur)
                cur, lines = None, []
    if cur is not None:  # unterminated procedure: keep what we have
        cur.source = "\n".join(lines)
        procs.append(cur)
    names = {p.name for p in procs}
    for p in procs:
        body = "\n".join(p.source.splitlines()[1:])
        p.calls = sorted(n for n in names if n != p.name and re.search(rf"\b{re.escape(n)}\b", body))
    return procs


def classify(proc: Procedure) -> Procedure:
    body = [ln for ln in proc.source.splitlines()]
    for pattern, reason, suggestion in _MANUAL_RULES:
        if pattern.search(proc.source):
            proc.vba_class, proc.reason, proc.suggestion = MANUAL, reason, suggestion
            return proc
    significant = [ln for ln in body if ln.strip()]
    if significant and all(_STANDARD_STMT.match(ln) for ln in significant):
        proc.vba_class = STANDARD
        proc.reason = "uses only statements that map to declarative rules"
    else:
        proc.vba_class = TRANSLATABLE
        proc.reason = "contains logic that needs translation and owner review"
    return proc


def inventory(modules: list[dict]) -> list[Procedure]:
    out: list[Procedure] = []
    for mod in modules:
        out.extend(classify(p) for p in parse_module(mod["name"], mod.get("source", "")))
    return out
