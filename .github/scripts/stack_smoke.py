"""End-to-end check of the running stack, through the frontend: nginx serves the page, and proxies the API to the backend.

Usage: stack_smoke.py BASE_URL
Set STACK_DEV_AUTH=1 when the backend runs with A2W_DEV_AUTH=1. Then the script also publishes a small application through the
proxy, writes a row, and reads the rows back, which proves that the identity headers and the request bodies pass through nginx.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

BASE = sys.argv[1].rstrip("/")
failures: list[str] = []


def call(method, path, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method, headers={"content-type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, dict(r.headers), raw
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


def check(name, ok, detail=""):
    print(("ok   " if ok else "FAIL ") + name + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


s, h, b = call("GET", "/healthz")
check("the frontend answers /healthz", s == 200 and b.strip() == b"ok", f"{s} {b[:60]!r}")

s, h, b = call("GET", "/")
check("the page is served", s == 200 and b"Access2Web" in b, f"{s}")
low = {k.lower(): v for k, v in h.items()}
check("the page carries a content security policy", "default-src 'none'" in low.get("content-security-policy", ""), str(low.get("content-security-policy")))
check("the page is not sniffed and is not cached without checking", low.get("x-content-type-options") == "nosniff" and low.get("cache-control") == "no-cache")
check("nginx does not say which version it is", "nginx/" not in low.get("server", ""), low.get("server", ""))

s, h, b = call("GET", "/main.js")
check("the script is served as JavaScript", s == 200 and "javascript" in {k.lower(): v for k, v in h.items()}.get("content-type", ""), f"{s}")

s, h, b = call("GET", "/apps/anything")
check("a route of the page falls back to the page", s == 200 and b"Access2Web" in b, f"{s}")

s, h, b = call("GET", "/api/apps/none")
check("the API is reached through the proxy, and refuses a caller with no identity", s == 401, f"{s} {b[:80]!r}")

s, h, b = call("GET", "/api/nothing-here")
check("a path that the API does not have is the API's own 404", s == 404, f"{s}")

if os.environ.get("STACK_DEV_AUTH") == "1":
    slug = "smoke_" + uuid.uuid4().hex[:8]
    owner = {"x-a2w-user": "olive", "x-a2w-roles": "app_owner"}
    extraction = {"tables": [{"name": "Items", "primary_key": ["Id"],
                              "fields": [{"name": "Id", "type": "AutoNumber"}, {"name": "Name", "type": "Short Text", "size": 20}],
                              "rows": [{"Id": 1, "Name": "Alpha"}, {"Id": 2, "Name": "Beta"}]}],
                  "relationships": [], "queries": [], "forms": [], "modules": []}
    s, h, b = call("POST", "/api/authoring/import-jobs", extraction, owner)
    job = json.loads(b).get("job") if s == 200 else None
    check("a job is created through the proxy, with the identity headers passed on", s == 200 and job, f"{s} {b[:120]!r}")
    if job:
        grants = [{"subject_type": "user", "subject_id": "reader", "level": "view_data"},
                  {"subject_type": "user", "subject_id": "writer", "level": "edit_data"}]
        s, h, b = call("POST", f"/api/authoring/import-jobs/{job}/publish", {
            "slug": slug, "name": slug, "confirmed_classification": "personal", "permissions_confirmed": True, "grants": grants}, owner)
        check("the application is published", s == 200, f"{s} {b[:200]!r}")
        s, h, b = call("POST", f"/api/apps/{slug}/tables/items/records", {"name": "Gamma"}, {"x-a2w-user": "writer"})
        check("a row is written", s == 201, f"{s} {b[:120]!r}")
        s, h, b = call("POST", f"/api/apps/{slug}/tables/items/records", {"name": "x" * 21}, {"x-a2w-user": "writer"})
        check("a value longer than the Access size is refused with 400", s == 400, f"{s} {b[:120]!r}")
        s, h, b = call("GET", f"/api/apps/{slug}/tables/items/records", headers={"x-a2w-user": "reader"})
        names = sorted(r["name"] for r in json.loads(b)["records"]) if s == 200 else []
        check("the rows are read back, the migrated ones and the new one", names == ["Alpha", "Beta", "Gamma"], f"{s} {names}")
        s, h, b = call("GET", f"/api/apps/{slug}/tables/items/records", headers={"x-a2w-user": "stranger"})
        check("a person with no grant is refused", s == 403, f"{s}")

if failures:
    print(f"\n{len(failures)} check(s) failed: {failures}")
    sys.exit(1)
print("\nall checks passed")
