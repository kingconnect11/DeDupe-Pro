#!/usr/bin/env python3
"""Verify Synology VCF note parse/escape roundtrips and merge-union integrity."""

from __future__ import annotations

import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from test_note_roundtrip import (  # noqa: E402
    combine_notes,
    escape_vcard_value,
    note_char_count,
    unescape_vcard_value,
    unfold_vcard,
    unique_notes,
)

DEFAULT_VCF = Path.home() / "Documents/Contacts/ALLSynologyContactsSep292025.vcf"


def parse_contacts(text: str) -> list[dict]:
    contacts: list[dict] = []
    for block in re.split(r"(?=BEGIN:VCARD)", text, flags=re.I):
        if "BEGIN:VCARD" not in block.upper():
            continue
        c: dict = {
            "raw": block,
            "name": "",
            "emails": [],
            "phones": [],
            "notes": "",
        }
        note_parts: list[str] = []
        for line in unfold_vcard(block).splitlines():
            colon = line.find(":")
            if colon < 0:
                continue
            prop = line[:colon].upper().split(";", 1)[0]
            val = line[colon + 1 :].strip()
            if not val:
                continue
            if prop == "FN":
                c["name"] = unescape_vcard_value(val)
            elif prop == "EMAIL":
                c["emails"].append(val.lower())
            elif prop == "TEL":
                digits = re.sub(r"\D", "", val)
                if digits.startswith("1") and len(digits) == 11:
                    digits = digits[1:]
                if digits:
                    c["phones"].append(digits)
            elif prop == "NOTE":
                note_parts.append(unescape_vcard_value(val))
        if note_parts:
            c["notes"] = combine_notes(note_parts)
        if c["name"] or c["emails"] or c["phones"]:
            contacts.append(c)
    return contacts


def email_duplicate_groups(contacts: list[dict]) -> list[list[dict]]:
    by_email: dict[str, list[dict]] = defaultdict(list)
    for c in contacts:
        for e in set(c["emails"]):
            by_email[e].append(c)

    groups: list[list[dict]] = []
    used: set[frozenset[int]] = set()
    for bucket in by_email.values():
        distinct: list[dict] = []
        seen: set[int] = set()
        for c in bucket:
            cid = id(c)
            if cid in seen:
                continue
            seen.add(cid)
            distinct.append(c)
        if len(distinct) < 2:
            continue
        key = frozenset(id(c) for c in distinct)
        if key in used:
            continue
        used.add(key)
        groups.append(distinct)
    return groups


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_VCF
    if not path.exists():
        print(f"FAIL: file not found: {path}")
        return 1

    text = path.read_text(encoding="utf-8", errors="replace")
    contacts = parse_contacts(text)
    with_notes = [c for c in contacts if c["notes"]]

    roundtrip_fail = 0
    total_note_chars = 0
    for c in with_notes:
        total_note_chars += note_char_count(c["notes"])
        back = unescape_vcard_value(escape_vcard_value(c["notes"]))
        if back != c["notes"]:
            roundtrip_fail += 1

    merge_groups = email_duplicate_groups(contacts)
    integrity_fail = 0
    for group in merge_groups:
        merged = combine_notes([c["notes"] for c in group])
        source = sum(note_char_count(n) for n in unique_notes([c["notes"] for c in group]))
        if note_char_count(merged) < source:
            integrity_fail += 1

    print(f"File: {path}")
    print(f"Contacts: {len(contacts)}")
    print(f"With notes: {len(with_notes)}")
    print(f"Total note chars: {total_note_chars}")
    print(f"Note escape roundtrip failures: {roundtrip_fail}")
    print(f"Email-duplicate merge groups: {len(merge_groups)}")
    print(f"Merge note-integrity failures: {integrity_fail}")

    if roundtrip_fail or integrity_fail:
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
