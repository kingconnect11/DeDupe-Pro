# DeDupe Pro v7 — changes from the July 23 review session with Phyllis

Source: recording "Phyllis Dedupe.wav" (2026-07-23, 29 min) plus a fresh review of `index.html` against the real Synology export (10,208 contacts) and the iPhone export (10,892 contacts).

## What Phyllis and Philip asked for → what changed

| Feedback (transcript) | Change |
|---|---|
| "Every time I try and change the name, it tries to exit" / "when you're editing a field, it'll disappear" | Root cause: the edit dialog closed on any click that landed on the dark overlay — which is what the browser reports when you drag to select text in a field and release outside the box. The dialog now closes only via Cancel, ×, Save, or Escape. Global keyboard shortcuts no longer fire while typing, and the stray `a` = "approve all" shortcut is gone. |
| "Do we need three copies of every email?" / "we don't need the name to be a part of the email" | Emails are cleaned at load time: `Amy X <amy@x.com>` becomes `amy@x.com`; comma-separated lists are split; repeats within a card and across the group are collapsed (case-insensitive, Gmail dots ignored). Phones likewise collapse `(415) 555-0100` / `+1 415 555 0100`. |
| "I'd want the name to be that [not the longer one]" | The merged result shows every spelling as a clickable chip; one click sets the kept name. Default is now the spelling used by most of the duplicate cards (was: the longest). The Edit dialog has the same chips plus an "Aa" button for Capitalize Each Word. Spellings that carry extra words (e.g. *Handyman, Al Holmes*) are recorded in the notes under `[Merged duplicates]` so nothing is lost. |
| "A button right here that says just view your contacts" | New **Browse Contacts** screen: search (name, phone, email, company, notes), A–Z index, and a full card view with the complete notes. Works on any loaded export, or on the cleaned result after merging. This is the safe way to read an export on a Mac without importing it. |
| "I'll send you an email with the list [of duplicates]" | **Duplicate list (.txt)** download: every group, alphabetised, with each card's name, emails, phones, company and note length — plain text for email or printing. |
| Synology export + iPhone export → "find every duplicate between them" and then "add what isn't there already" | Two-file mode with a "between files only" option. The export screen offers **Only in "iPhone"** and **Only in "Synology"** `.vcf` downloads so only the missing contacts need importing. Cards show which file they came from. |
| "777 … not sure if that's contacts or groups" / low threshold produced 1,200 "dupes" | The result toast and export page now say "N groups covering M contacts" and "removing K duplicate cards". Threshold presets (Strict 80 / Balanced 60 / Aggressive 45) with plain-English descriptions; default raised from 50 to 60. |
| "It's awfully hard for me to see" (from the same evening) | Light/dark toggle and a large-text toggle in the header; larger base font and higher-contrast text throughout. |

## Data-safety fixes found by testing against the real export (not in the transcript)

* **Merged contacts were losing fields.** The old merge rebuilt a card from name/email/phone/org/title/birthday/URL/notes only — so **addresses (206 of 199 auto-merge groups had them), phone/email labels, photos, categories, and custom properties were dropped** on every merge. v7 merges at the vCard property level: the output is a superset of every input property, deduplicated by normalised value. A new field-integrity check confirms every source email, phone and address is present in the merged card.
* **Conflicting single-value fields** (two different companies) are no longer silently overwritten — the loser is written into the notes footer.
* **Names were displayed and matched with vCard escapes intact** (`Cath\, Sandra`). Now decoded.
* **Mixed line endings** (CRLF originals + LF rebuilt cards) → the whole export is CRLF, long lines folded at 75 characters per RFC 2426.
* **Chained groups.** Confidence used to show the *best* pair in a group, hiding weak links (e.g. Cindy Mapes chained into "USAA Claims" through a shared 800 number). Groups now carry the weakest link, a *Chained* warning when not every pair matched directly, and *Large group* for 5+. Any warning blocks pre-approval.
* **Toll-free numbers** are weak evidence (shared company lines). **Same last name + shared phone** (spouses, households) deliberately scores under 50 so it is not grouped by default.
* **Empty Apple placeholder cards** (`N:;;;;`, 385 in the iPhone export) are counted and dropped, not exported as blanks.
* **"Not a dupe"** button removes one card from a group and re-scores the rest; Undo covers it.
* Junk typed into an EMAIL field that contained an escaped newline could split a merged card — now encoded safely.

## Verification (2026-09-05)

`node tests/test_engine.mjs <export>` loads the engine straight out of `index.html`:

* Synology export: 792 groups at 60%, note integrity OK, field integrity OK, export CRLF-only, second pass finds 0 groups at 95%+.
* iPhone export: same checks pass.
* Both files together: 7,879 groups (4,304 pre-approved) in about one second; 1,640 contacts exist only in the iPhone export, 1,177 only in the Synology export.

## Still to do with Phyllis present

* Decide which store is authoritative (Synology vs. iPhone), import the cleaned `.vcf` there, and let CardDAV propagate. Classic Outlook needs the CSV path.
* Review the pending groups together, especially *Different organizations* ones — Phyllis often stores several people/roles under one contact on purpose (e.g. a doctor's nurse under the doctor's name).

## 2026-10-05 pre-visit check

* Review progress now auto-saves in the browser (keyed by file + settings). Reloading the same export and clicking Find Duplicates asks whether to pick up where you left off; Merge / Skip / name choice / "Not a dupe" all restore. Closing the tab mid-review asks first.
* Removed regex lookbehind from the parser so the script also loads on older Safari.
* Live site re-verified against the Synology export: 24/24 engine tests, note + field integrity OK.

## 2026-10-05 Outlook CSV support

Philip: "I need it to work with Outlook CSVs." The app now loads classic Outlook contact exports (.csv) directly, alongside .vcf, and exports an Outlook CSV with the source file's exact columns. Verified with a hand-built Windows-1252 fixture and with the full Synology export round-tripped through Outlook CSV (10,208 rows, no note text lost, merge integrity OK, every email/phone present in the output). 40/40 engine tests. On-site checks still needed with a real IBP export (see README).
