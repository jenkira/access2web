"""Data classification at upload (FR-22). A heuristic that suggests a class; the owner confirms it."""
import re

_SENSITIVE = re.compile(
    r"(ssn|tax_?file|medicare|passport|licen[cs]e|dob|birth|diagnos|medical|health|patient|"
    r"salary|wage|bank|account_?no|iban|password|credit|card_?no|ethnic|religio|criminal)", re.I)
_PERSONAL = re.compile(r"(e_?mail|phone|mobile|address|first_?name|last_?name|surname|full_?name|postcode)", re.I)


def classify_fields(entities: list[tuple[str, list[str]]]) -> dict:
    """Return a suggested classification and the field names that drove it."""
    hits: dict[str, list[str]] = {"sensitive": [], "personal": []}
    for table, fields in entities:
        for f in fields:
            if _SENSITIVE.search(f):
                hits["sensitive"].append(f"{table}.{f}")
            elif _PERSONAL.search(f):
                hits["personal"].append(f"{table}.{f}")
    level = "sensitive" if hits["sensitive"] else "personal" if hits["personal"] else "general"
    return {"suggested": level, "fields": hits}
