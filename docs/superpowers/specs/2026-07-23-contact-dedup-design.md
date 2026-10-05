# Contact Dedup Rebuild — Design Spec

**Date:** 2026-07-23  
**Client:** Phyllis Cath tech support  
**Status:** Approved

## Goal

Rebuild DeDupe Pro so Synology contact exports (~9–10k vCards) can be deduplicated **without losing any NOTE content**, especially multi-line notes. Tonight: Synology-only offline cleanup; import later via Outlook on IBP.

## Decisions

| Topic | Choice |
|-------|--------|
| Matching | Aggressive (email, phone, name, nickname, phonetic) with confidence scores |
| Auto-merge | ≥95% only; all else requires review |
| Notes merge | Concatenate all unique notes with separator `\n---\n` |
| Priority 2 (iPhone) | Out of scope tonight |
| Note restoration | Best-effort via merge union from richer duplicates in the loaded file |
| Write-back | Clean `.vcf` → import Outlook on IBP → CalDav Synchronizer |
| Deliverable | Cleaned `.vcf` after review (+ optional live import on-site) |
| Platform | Browser DeDupe Pro (`index.html`) |

## Architecture

Single-page offline web app. User drops one Synology `.vcf`. App parses, finds duplicate groups, buckets by confidence, auto-approves ≥95%, lets user review the rest, then exports:

1. Cleaned `.vcf` (note-safe)
2. Audit log (JSON or text): groups merged, survivors, before/after note lengths
3. Hard gate: export blocked if any merged identity’s total note character count shrinks

No live CardDAV/Outlook writes from the tool.

## Note safety (acceptance bar)

- Parse: unfold folded lines; unescape `\n`, `\,`, `\;`, `\\`; accumulate multiple `NOTE` properties
- Merge: never drop unique note text; join with `\n---\n`
- Export: escape NOTE for vCard 3.0; preserve line breaks as `\n`
- Unmerged contacts: prefer original raw vCard block over rebuild (avoid field loss)
- Verification: for every merge, `len(merged_notes) >= sum(unique_source_note_lengths)` after normalizing separator/whitespace rules documented in audit

## Matching (existing behavior retained / tightened)

Keep current confidence model (email/phone/name/nickname/phonetic). Aggressive threshold for *detection*; auto-approve only ≥95%. Warn on conflicting org / email domains / weak name-only matches.

## Safety / operability

- Original file never overwritten; downloads are timestamped
- Dry-run review UI before download
- Audit log of every merge
- Mac guidance: do not double-click `.vcf`; Open With TextEdit or rename to `.txt`

## Out of scope tonight

- iPhone list merge
- Editing Synology Contacts DSM UI
- PST automation / Outlook COM
- Parallel runs on IBP + Dell

## Success criteria

1. Synology test VCF: zero note-character loss across approved merges  
2. Idempotent: re-run on output finds no ≥95% groups (or none at configured floor)  
3. Contact count drop equals duplicates removed  
4. Philip can complete review + download on Mac without auto-import into Contacts  
