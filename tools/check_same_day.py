#!/usr/bin/env python3
r"""Same-day support-work / physiotherapy check for NDIS Invoice Tool v2 (read-only).

HARD rule: one participant cannot have support work and physiotherapy on the same date.
Evidence: sessions (open or invoiced) and non-void invoice lines, from the v2 ledger and the
v1 ledger. Subcontractor Physio sessions/invoices (billed to a company) are ignored. Both files are opened 'rb' and never written. Python 3 standard library only.

Usage (Windows PowerShell):
  python check_same_day.py                       # report all conflicts in both ledgers
  python check_same_day.py --client "Robert Peters" --date 2026-11-17 --type physio
                                                  # would a new physio session on that day be allowed?
Exit codes: 0 = no conflict, 2 = conflict found, 1 = error (file missing / bad input).
"""
import argparse
import json
import os
import sys
from collections import defaultdict
from datetime import datetime

DEFAULT_V2 = r"D:\Grokbot\NDIS Invoices\ledger\invoice-data-v2.json"
DEFAULT_V1 = os.path.join(os.path.expanduser("~"), ".openjarvis", "invoice-data.json")


def load_readonly(path):
    with open(path, "rb") as f:  # read-only, never written
        return json.loads(f.read().decode("utf-8-sig"))


def norm(text):
    return " ".join(str(text or "").split()).lower()


def person_key(ndis, name):
    ndis = str(ndis or "").strip()
    return ("ndis:" + ndis) if ndis else ("name:" + norm(name))


def parse_date(text):
    for fmt in ("%Y-%m-%d", "%d/%m/%Y"):
        try:
            return datetime.strptime(text.strip(), fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError("date must be YYYY-MM-DD or DD/MM/YYYY: " + text)


def collect(ledgers):
    """Return {person_key: {"name": str, "days": {date: {"support"|"physio": [evidence]}}}}."""
    people = {}

    def entry(key, name):
        p = people.setdefault(key, {"name": name, "days": defaultdict(lambda: defaultdict(list))})
        if name and not p["name"]:
            p["name"] = name
        return p

    for label, data in ledgers:
        clients = {c.get("id"): c for c in data.get("clients", []) if isinstance(c, dict)}
        sessions = [s for s in data.get("sessions", []) if isinstance(s, dict)]
        by_id = {s.get("id"): s for s in sessions}
        for s in sessions:
            if s.get("kind") == "subcontractor":
                continue  # Subcontractor Physio (billed to a company) is not part of the NDIS same-day rule
            c = clients.get(s.get("clientId"), {})
            cat = "physio" if s.get("kind") == "physio" else "support"
            p = entry(person_key(c.get("ndisNumber"), c.get("name")), c.get("name", "?"))
            p["days"][s.get("date")][cat].append("%s session %s-%s" % (label, s.get("startTime", ""), s.get("endTime", "")))
        for inv in data.get("invoices", []):
            if not isinstance(inv, dict) or inv.get("voided") or inv.get("invoiceType") == "subcontractor":
                continue
            cat = "physio" if inv.get("invoiceType") == "physio" else "support"
            ic = inv.get("client") or {}
            key = None
            for sid in inv.get("sessionIds") or []:
                s = by_id.get(sid)
                if s and s.get("clientId") in clients:
                    c = clients[s["clientId"]]
                    key, name = person_key(c.get("ndisNumber"), c.get("name")), c.get("name")
                    break
            if key is None:
                key, name = person_key(ic.get("ndisNumber"), ic.get("name")), ic.get("name", "?")
            dates = sorted({l.get("serviceDate") for l in inv.get("lines", []) if isinstance(l, dict) and l.get("serviceDate")})
            p = entry(key, name)
            for d in dates:
                p["days"][d][cat].append("%s invoice %s" % (label, inv.get("number", "?")))
    return people


def find_person(people, wanted):
    w = norm(wanted)
    hits = [k for k, p in people.items() if k == "ndis:" + wanted.strip() or norm(p["name"]) == w]
    if not hits:
        hits = [k for k, p in people.items() if w and w in norm(p["name"])]
    return hits


def main(argv=None):
    ap = argparse.ArgumentParser(description="Cross-category same-day check (read-only).")
    ap.add_argument("--v2", default=DEFAULT_V2, help="v2 ledger (default: %(default)s)")
    ap.add_argument("--v1", default=DEFAULT_V1, help="v1 ledger, read-only (default: %(default)s)")
    ap.add_argument("--no-v1", action="store_true", help="skip the v1 ledger")
    ap.add_argument("--client", help="participant name or NDIS number (for a proposed session)")
    ap.add_argument("--date", help="proposed session date, YYYY-MM-DD or DD/MM/YYYY")
    ap.add_argument("--type", choices=["physio", "support"], help="proposed session type")
    a = ap.parse_args(argv)
    try:
        sys.stdout.reconfigure(errors="replace")
    except AttributeError:
        pass

    ledgers = []
    for label, path in (("v2", a.v2), ("v1", None if a.no_v1 else a.v1)):
        if path is None:
            continue
        if not os.path.isfile(path):
            print("ERROR: %s ledger not found: %s" % (label, path))
            return 1
        ledgers.append((label, load_readonly(path)))
        print("read-only: %s ledger %s" % (label, path))
    people = collect(ledgers)

    proposed = [a.client, a.date, a.type]
    if any(proposed):
        if not all(proposed):
            print("ERROR: --client, --date and --type must be given together")
            return 1
        try:
            date = parse_date(a.date)
        except ValueError as e:
            print("ERROR: " + str(e))
            return 1
        hits = find_person(people, a.client)
        if len(hits) > 1:
            print("ERROR: more than one participant matches %r: %s" % (a.client, ", ".join(people[h]["name"] for h in hits)))
            return 1
        other = "support" if a.type == "physio" else "physio"
        evidence = people[hits[0]]["days"].get(date, {}).get(other, []) if hits else []
        name = people[hits[0]]["name"] if hits else a.client + " (not in ledgers)"
        if evidence:
            if a.type == "physio":
                print("BLOCKED: 這一天已有 support work，不能加物理治療 / This day already has support work - physiotherapy cannot be added.")
            else:
                print("BLOCKED: 這一天已有物理治療，不能加 support work / This day already has physiotherapy - support work cannot be added.")
            print("  %s  %s" % (name, date))
            for e in sorted(set(evidence)):
                print("    - " + e)
            return 2
        same = people[hits[0]]["days"].get(date, {}).get(a.type, []) if hits else []
        print("OK: no %s on %s for %s - a %s session is allowed by the same-day rule." % (other, date, name, a.type))
        if same:
            print("  (already %d %s item(s) that day; check times don't overlap)" % (len(set(same)), a.type))
        return 0

    conflicts = 0
    for key in sorted(people, key=lambda k: people[k]["name"] or ""):
        p = people[key]
        for d in sorted(x for x in p["days"] if x):
            cats = p["days"][d]
            if cats.get("support") and cats.get("physio"):
                conflicts += 1
                print("CONFLICT  %s  %s" % (p["name"], d))
                for cat in ("support", "physio"):
                    for e in sorted(set(cats[cat])):
                        print("    %-7s %s" % (cat, e))
    if conflicts:
        print("%d cross-category same-day conflict(s) found." % conflicts)
        return 2
    print("OK: no participant has support work and physiotherapy on the same date (%d participant(s) checked)." % len(people))
    return 0


if __name__ == "__main__":
    sys.exit(main())
