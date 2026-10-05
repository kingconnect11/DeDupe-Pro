# DeDupe Pro v7

A single-file, offline web app (`index.html`) that finds and merges duplicate contacts in vCard (`.vcf`) exports **without losing anything** — especially the multi-line Notes that an earlier tool stripped.

Live: https://dedupe-pro.vercel.app · Works equally well by opening `index.html` locally. No data leaves the browser.

## What it does

1. **Load** an Outlook contacts export (`.csv`) or a `.vcf` (Synology / iPhone / Mac). Optionally load a second file of either kind to compare the two lists.
2. **Find Duplicates** — contacts are grouped by shared email, shared phone, and name similarity (exact, nickname, "Last, First" vs "First Last", phonetic). Every group shows a confidence score, the reasons it matched, and warnings.
3. **Review** — sure things (95%+ with no warnings) are pre-approved. Everything else waits for a *Merge*, *Edit*, or *Skip*. In an expanded group you can pick which name spelling to keep, take a card out of the group ("Not a dupe"), and see the exact merged result before deciding.
4. **Export** — a clean `.vcf`, an audit log, an Outlook-compatible CSV, a printable duplicate list, and (with two files) "only in file 2" / "only in file 1" `.vcf` files.
5. **Browse Contacts** — a read-only viewer for any loaded file (search, A–Z index, full card with notes). This is the safe way to look up a number from an export on a Mac without importing it into Contacts.

## The guarantees

* **Notes are never lost.** Every unique note body from every duplicate is kept, joined with `---`. The `.vcf` download is blocked if any approved merge has fewer note characters than its sources (only possible if a reviewer edits notes by hand).
* **Fields are never lost.** A merged card is a property-level superset of its inputs: every email, phone (with its label), address, URL, photo, category, and custom `X-` property survives. Where a single-valued field disagrees (two different companies), the winner is written to the field and the other is recorded in the notes under `[Merged duplicates]`, along with alternate name spellings that carry extra words (e.g. *Handyman, Al Holmes*).
* **Untouched contacts are written back byte-for-byte** (line endings normalised to CRLF). Nothing is re-encoded unless it was merged.
* **Nothing is written anywhere.** The tool only produces downloads. Importing them into Synology/Outlook/iPhone is a deliberate, separate step. Keep the original export as the backup.

## Outlook CSV support

* Reads classic Outlook's export (File → Open & Export → Import/Export → Export to a file → Comma Separated Values → Contacts). Columns are matched by name, so other Outlook versions' column sets work too. Comma, semicolon and tab delimiters; UTF-8 or Windows-1252 (classic Outlook's "ANSI") are detected automatically.
* Outlook's filler values (`0/0/00` dates, `Normal`, `False`, `Unspecified`, auto-generated Initials) are treated as empty. The `E-mail Display Name` columns ("Name (address)") are ignored. Exchange `/o=…` addresses are resolved to the SMTP address in the display name.
* **Clean contacts for Outlook (.csv)** uses the loaded file's exact header, delimiter and encoding. Untouched rows are written back value-for-value. Merged rows put each value back in its original column, then a free column of the same kind; anything left over goes into Notes under `[Extra details — no matching Outlook column]`. The file is Windows-1252 when every character fits, otherwise UTF-8 with a BOM.
* If five or more notes are exactly 255 characters long, the app warns that the export itself may have been truncated.
* Import safely: back up the `.pst`, import the CSV into a **new, non-synced** contacts folder, check it, then swap it in. Importing over the live, synced folder duplicates or misses merges on every device. Don't open the CSV in Excel first.

## Matching rules (scores add up; groups form at or above the threshold, default 60%)

| Evidence | Points |
|---|---|
| Same email address | 50 |
| Same phone number (last 7 digits) | 40 |
| Same toll-free number (800/888/877/…) | 30, or 10 with a warning if the names are unrelated |
| Exact name (word order ignored) | 50 |
| Nickname match (Bob/Robert, Cathy/Catherine…) | 45 |
| Same first and last name, extra words differ | 42 |
| Names share two words | 35 |
| Same last name + first initial, or last name only on one side | 25 |
| Names share one word / last name only | 8 / 5 (deliberately below the floor — households share phones) |
| Same company | +10 |

Group-level warnings: *Chained* (A~B and B~C but A and C never matched directly), *Large group*, *Different organizations*, *Different birthdays*, *Name-only match*, *Names look unrelated*, *Shared toll-free number*. Any warning prevents pre-approval.

## Verification

```bash
node tests/test_engine.mjs                                   # unit tests on the real engine code
node tests/test_engine.mjs ~/Documents/Contacts/ALLSynologyContactsSep292025.vcf   # + real-file smoke test
python3 -m unittest tests/test_note_roundtrip.py             # note escape/merge mirror tests
```

Against the September 2025 Synology export (10,208 contacts, 3,448 with notes, 546,095 note characters): every merge passes the note and field integrity checks, and a second pass over the exported file finds no 95%+ groups.

## Importing the result

* **Synology Contacts / iPhone / Mac Contacts** import a multi-contact `.vcf` directly.
* **Classic Outlook for Windows** imports only the *first* contact from a `.vcf`. Use the Outlook CSV download (see above).
* Because contacts sync through CardDAV to every device, import into **one** place and let it propagate. Never edit inside the Synology DSM Contacts UI.

## Files

* `index.html` — the whole app (engine between `// ENGINE-START` and `// ENGINE-END`, then the UI).
* `tests/test_engine.mjs` — Node tests that load the engine straight out of `index.html` (including an Outlook CSV round trip of the real export).
* `tests/fixtures/outlook_export_cp1252.csv` — hand-built classic-Outlook export in Windows-1252 with multi-line notes, quotes, filler values and an Exchange address.
* `tests/test_note_roundtrip.py`, `tests/verify_synology_notes.py` — Python mirrors of the note handling.
* `docs/` — design spec and plan from the July 2026 rebuild; `Phyllis_Contact_Dedup_Rebuild_Handoff.md` — background on the environment and the original notes-loss incident.
