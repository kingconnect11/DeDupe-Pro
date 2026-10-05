#!/usr/bin/env python3
"""Note-safety unit tests mirroring DeDupe Pro vCard NOTE handling."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

NOTE_SEP = "\n---\n"
FIXTURES = Path(__file__).parent / "fixtures"


def unfold_vcard(text: str) -> str:
    return re.sub(r"\r?\n[ \t]", "", text)


def unescape_vcard_value(val: str) -> str:
    out: list[str] = []
    i = 0
    while i < len(val):
        if val[i] == "\\" and i + 1 < len(val):
            n = val[i + 1]
            if n in ("n", "N"):
                out.append("\n")
            elif n in (",", ";", "\\"):
                out.append(n)
            else:
                out.append(n)
            i += 2
            continue
        out.append(val[i])
        i += 1
    return "".join(out)


def escape_vcard_value(val: str) -> str:
    s = (val or "").replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("\\", "\\\\")
    s = s.replace("\n", "\\n")
    s = s.replace(",", "\\,")
    s = s.replace(";", "\\;")
    return s


def _norm(n: str) -> str:
    return re.sub(r"[ \t]+\n", "\n", (n or "").replace("\r\n", "\n").replace("\r", "\n")).strip()


def unique_notes(notes: list[str]) -> list[str]:
    """Mirror of the JS uniqueNotes(): drop exact repeats and notes fully contained in another."""
    seen: set[str] = set()
    out: list[str] = []
    for n in notes:
        if not n or not n.strip():
            continue
        key = _norm(n)
        if key in seen:
            continue
        if any(key in _norm(o) for o in out):
            continue
        for i, o in enumerate(out):
            if _norm(o) in key:
                out[i] = n
                break
        else:
            out.append(n)
        seen.add(key)
    return out


def combine_notes(notes: list[str]) -> str:
    return NOTE_SEP.join(unique_notes(notes))


def note_char_count(s: str) -> int:
    return len((s or "").replace("\r", ""))


def parse_notes_from_vcf(text: str) -> list[str]:
    """Return list of note strings (one per contact that has notes)."""
    notes: list[str] = []
    blocks = re.split(r"(?=BEGIN:VCARD)", text, flags=re.I)
    for block in blocks:
        if "BEGIN:VCARD" not in block.upper():
            continue
        contact_notes: list[str] = []
        for line in unfold_vcard(block).splitlines():
            if not line.upper().startswith("NOTE"):
                continue
            colon = line.find(":")
            if colon < 0:
                continue
            val = line[colon + 1 :].strip()
            if not val:
                continue
            contact_notes.append(unescape_vcard_value(val))
        if contact_notes:
            notes.append(combine_notes(contact_notes))
    return notes


class NoteSafetyTests(unittest.TestCase):
    def test_multiline_roundtrip(self) -> None:
        original = "Line one\nLine two\nLine three with comma, and; semicolon"
        escaped = escape_vcard_value(original)
        self.assertNotIn("\n", escaped)
        self.assertIn("\\n", escaped)
        restored = unescape_vcard_value(escaped)
        self.assertEqual(restored, original)

    def test_combine_preserves_all_unique(self) -> None:
        a = "Alpha note\nsecond line"
        b = "Beta unique"
        c = "Alpha note\nsecond line"  # duplicate of a
        merged = combine_notes([a, b, c])
        self.assertIn(a, merged)
        self.assertIn(b, merged)
        self.assertEqual(merged.count("---"), 1)
        source = sum(note_char_count(n) for n in unique_notes([a, b, c]))
        self.assertGreaterEqual(note_char_count(merged), source)

    def test_old_bug_semicolon_join_would_hurt_multiline(self) -> None:
        """Document why '; ' join was wrong vs NOTE_SEP."""
        a = "line1\nline2"
        b = "other"
        bad = "; ".join([a, b])
        good = combine_notes([a, b])
        self.assertIn("\n", good)
        # bad still has newlines but loses vCard structure when written raw;
        # good is what we escape as a single NOTE with \\n
        self.assertEqual(unescape_vcard_value(escape_vcard_value(good)), good)
        self.assertNotEqual(bad, good)

    def test_fixture_file(self) -> None:
        path = FIXTURES / "multinote.vcf"
        text = path.read_text(encoding="utf-8")
        notes = parse_notes_from_vcf(text)
        self.assertEqual(len(notes), 2)
        self.assertIn("First paragraph", notes[0])
        self.assertIn("Second paragraph", notes[0])
        # Contact 2 has two NOTE properties combined
        self.assertIn("Note A", notes[1])
        self.assertIn("Note B", notes[1])
        for n in notes:
            roundtrip = unescape_vcard_value(escape_vcard_value(n))
            self.assertEqual(roundtrip, n)

    def test_merge_integrity_gate(self) -> None:
        contacts = ["Long note one\nwith lines", "Short", "Long note one\nwith lines"]
        merged = combine_notes(contacts)
        source = sum(note_char_count(n) for n in unique_notes(contacts))
        self.assertGreaterEqual(note_char_count(merged), source)
        # Simulated old bug: keep only first line of first note
        broken = contacts[0].split("\n")[0]
        self.assertLess(note_char_count(broken), source)


if __name__ == "__main__":
    unittest.main()
