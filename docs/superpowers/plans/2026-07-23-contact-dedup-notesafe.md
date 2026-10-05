# Contact Dedup Note-Safe Rebuild — Implementation Plan

> **For agentic workers:** Execute inline in this session (user approved with "go"; time-critical).

**Goal:** Fix DeDupe Pro so Synology vCard dedupe never loses NOTE content; auto-merge ≥95%; audit + integrity gate.

**Architecture:** Surgical fixes to existing single-file `index.html` plus a Python verification script against the real Synology VCF.

**Tech Stack:** Vanilla JS (browser), Python 3 (verification)

---

### Task 1: Note escape/unescape + parse/merge/export fixes

**Files:**
- Modify: `index.html` (parser, mergeContacts, contactToVCard, generateVCardExport)
- Create: `tests/test_note_roundtrip.py`
- Create: `tests/fixtures/multinote.vcf`

- [ ] Add `unescapeVCardValue` / `escapeVCardValue`
- [ ] Parse: accumulate multiple NOTE; unescape
- [ ] Merge notes with `\n---\n`
- [ ] Export NOTE escaped; unmerged contacts use `raw` when present
- [ ] Gate export on note char integrity
- [ ] Default auto-merge ≥95% on; audit download; single-file Synology UX tip

### Task 2: Verify against Synology export

**Files:**
- Create: `tests/verify_synology_notes.py`

- [ ] Round-trip note fixtures
- [ ] Scan Synology VCF: parse notes, simulate union merges, assert no shrinkage
- [ ] Report contact/note counts

### Task 3: Commit design + working tool

- [ ] Commit spec, plan, index.html, tests
