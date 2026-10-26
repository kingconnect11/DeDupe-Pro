# Plan — on-site dedupe at Phyllis's (2026-10-26)

## Goal
Philip arrives with Phyllis's full contact list in whatever form her machines produce (most likely a classic-Outlook CSV export from the IBP tower on a flash drive; possibly a .vcf from the iPhone/Synology, a .pst, or a CSV that someone opened and re-saved in Excel). It must load into DeDupe Pro and dedupe **without any person or AI model reading the contact contents**.

Last visit failed because the export was an Outlook CSV and the app only read .vcf. CSV import was added on 2026-10-05 but has never been run on a real Outlook export.

## Two independent paths (either one is enough)

### Path A — in the browser (primary)
https://dedupe-pro.vercel.app (or `index.html` opened straight from disk). The file is read with FileReader in the page; nothing is uploaded. Loader changes for today:
- Encoding: UTF-8 (with/without BOM), UTF-16 LE/BE (BOM; Excel "Unicode Text" and some Outlook exports), else Windows-1252.
- Delimiters: comma, semicolon, tab.
- Column recognition by header alias, not one exact header set: classic Outlook, new Outlook / Outlook.com, Google Contacts CSV, and generic "Name / Email / Phone" spreadsheets. Unknown columns are kept as extra fields, never dropped. A CSV is accepted if any column looks like a name, email, or phone, not only an exact Outlook header.
- .xlsx (someone opened the CSV in Excel and saved): read in-browser by lazy-loading SheetJS from cdnjs.
- .pst / .olm / .zip: a clear message saying what to do instead.

### Path B — on Philip's Mac, through Claude, without Claude seeing the data
`node tools/convert-contacts.mjs <file>` uses the exact same engine (loaded from `index.html`). It writes `<file>.converted.vcf` and `<file>.converted-outlook.csv` next to the input and prints ONLY counts, the detected format and encoding, the column mapping (header names), and integrity numbers. It never prints names, emails, phones, or notes, so when Claude runs it, only aggregates reach the model.
- .xlsx via the same JS path (openpyxl fallback in Python is available on this Mac).
- .pst via `readpst` (Homebrew `libpst`) → .vcf → engine. Not verified on a real PST.

## On-site sequence
1. Get the export onto the flash drive: Outlook → File → Open & Export → Import/Export → Export to a file → Comma Separated Values → pick the Contacts folder. Don't open it in Excel.
2. Drag it onto the app. Check the loaded count against Outlook's own count, and the "columns recognised" line.
3. If the app rejects it → Path B on the Mac.
4. Dedupe and review as before; export the Outlook CSV with the same columns.
5. Import into a NEW, non-synced Outlook contacts folder only after a PST backup.

## Privacy constraints
- No contact content printed to any terminal Claude reads, written to any deployed path, or committed.
- `.vercelignore` keeps the deploy to `index.html` only.
