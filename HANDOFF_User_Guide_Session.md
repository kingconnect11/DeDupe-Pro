# HANDOFF: Create the DeDupe Pro User Guide (and revise the app if needed)

**Prepared:** July 24, 2026, after the successful rebuild + verification session
**For:** The next session (human or AI) that will write the end-user guide for DeDupe Pro
**Supersedes nothing; complements:** `Phyllis_Contact_Dedup_Rebuild_Handoff.md` (the rebuild mission — read it for full environment background)

---

## 1. What happened since the last handoff (you need this context)

The dedup tool was **rebuilt from scratch and verified on the real data** in the session that wrote this doc. Summary:

- **Architecture:** two files only. `index.html` = UI (dark theme, screens: Upload → Review → Results). `engine.js` = all logic (parse/match/merge/export), zero-dependency, UMD (`window.DedupeEngine` in browser, `module.exports` in Node). No build step, no framework, no server.
- **Live at:** https://dedupe-pro.vercel.app (Vercel project `dedupe-pro`, linked in `.vercel/`).
- **The old note-stripping defect is fixed and proven fixed:** merges union all notes (exact-dup and fully-contained notes deduped, survivors joined with a separator), multi-line notes round-trip byte-identically, conflicting singleton fields are preserved in a `[Merged from duplicate]` note appendix, losing UIDs become `X-MERGED-UID` props, photos are unioned byte-identically.
- **Verification baseline on the real files** (use as the regression oracle if you change the engine):
  - Master `ALLSynologyContactsSep292025.vcf`: 10,208 cards → 777 groups (166 `autoMergeSafe`, 611 review-only). Auto-merge-only export = 9,969 contacts. **Note integrity: zero losses** (546,124 → 561,631 chars).
  - iPhone `All iPhone Contacts.vcf`: 10,892 cards incl. 6 empty junk cards (`N:;;;;` — they pass through untouched, never merge).
  - Combined: 21,100 → 12,548 after auto-merges; 9,022 cross-file groups; **zero note losses**; 108 PHOTO props all byte-identical to source.
- **Test suite:** `node tests/run-tests.js` → 22 tests, must stay green. `node tests/verify-real-data.js` → runs the engine against the real files READ-ONLY, writes only to `/tmp/dedupe-verify/`, asserts zero note loss + count sanity + idempotency.
- **Privacy posture (verified, do not regress):** app is 100% client-side — no network calls, no storage, no analytics; only external request is Google Fonts. Real contact data must NEVER be committed, deployed, or copied into the project dir. `.vercelignore` already excludes `tests/`, `*.md`, configs. Verification outputs go to `/tmp` only and should be deleted after use.

---

## 2. THE PROMPT — copy everything between the markers into the next session

--- BEGIN PROMPT ---

You are writing the end-user guide for **DeDupe Pro**, a contact-deduplication web app live at https://dedupe-pro.vercel.app, and making small revisions to the app if the guide-writing process exposes problems.

**First, read these in order:**
1. `HANDOFF_User_Guide_Session.md` in `/Users/iamtheking/Documents/Apps/DeDupe Pro` (context, baselines, safety rules — the doc containing this prompt).
2. `Phyllis_Cath_Tech_Handoff`-era background in `Phyllis_Contact_Dedup_Rebuild_Handoff.md` (same folder) — especially §2 (sync topology) and §8 (warnings). The rules there still bind: never edit contacts in the Synology DSM interface, never run dedup on two machines, back up before any import, one authoritative machine only.
3. `index.html` — quote the UI's actual labels exactly in the guide (e.g. "Master Contact File (Synology)", "Second File (optional — iPhone/iCloud export)", "Auto-approve safe merges only", "Download Merge Plan", the note-integrity badge, the Results screen integrity panel). Do not write the guide from memory or from this prompt; the shipped UI is the source of truth.

**Then write `USER_GUIDE.md`** (project root; it is excluded from deployment by `.vercelignore`). Audience: **Phyllis, a non-technical end user**, with Philip as the technical safety-net. Plain language, numbered steps, no jargon without a one-line explanation. Cover:

1. **What this tool does and what it never does** — it runs entirely in the browser on your computer; contacts are never uploaded anywhere; your original files are never changed; nothing touches Synology/Outlook/iCloud until *you* import the result.
2. **Getting the contacts out (before the tool):**
   - Synology (master list): how to export the full contact list from Synology Contacts as .vcf.
   - iPhone-only contacts: they live in iCloud → iCloud.com → Contacts → Select All → Export vCard (this automatically excludes the Synology contacts). Note: an export made *on the iPhone itself* mixes Synology contacts in — that's okay, the tool dedupes the overlap, but the iCloud.com export is cleaner.
3. **Using the tool, step by step:** drop the master file (second file optional); threshold slider guidance (leave at 50% unless told otherwise); "Auto-approve safe merges only" explained in one sentence; what the Review screen shows (confidence %, match factors, warnings, notes in each card, the green "Notes preserved" badge); how to approve/skip/edit a group; "Download Merge Plan" for a dry-run record; Export → which download to pick (vCard for re-import; CSV for eyeballing in Excel; Audit Log .txt as the permanent record of what was merged).
4. **Reading the Results screen:** the four counts and the note-integrity panel. "0 notes lost" is the expected, required outcome — if it ever shows anything else, STOP and call Philip; do not import.
5. **Putting the clean contacts back (do this part with Philip):** back up first (export the current contacts and keep the file somewhere safe); import the merged .vcf on ONE machine only (the IBP tower via Outlook, letting CalDav Synchronizer propagate to Synology and the phones — never import on two machines, never edit inside the Synology web interface); then spot-check 5–10 contacts on the phone, especially ones with long notes.
6. **Troubleshooting:** file won't load (must be .vcf), very large files are okay but slow, what "review-only" groups are and why the tool refuses to auto-merge name-only matches, who to call.

If you can drive a browser, take screenshots and reference them; if not, describe each screen using the exact labels from `index.html`. Also produce a PDF copy for Phyllis if tooling is available; keep the markdown as the source.

**If you find the app needs changes** (bugs, confusing labels, missing affordances the guide has to work around): keep changes minimal and consistent with the existing architecture (`engine.js` = logic, `index.html` = UI). After any change you MUST run, in this order, and show the results:
1. `node tests/run-tests.js` — all 22 tests green.
2. `node tests/verify-real-data.js` — asserts zero note loss on the REAL files (it reads them read-only and writes only to `/tmp/dedupe-verify/`; delete that folder when done — it contains real contact data).
3. `node --check` on engine.js and on the extracted inline script of index.html.
Ask Philip before redeploying with `vercel --prod`, and never commit or deploy real contact data (`.vercelignore` must keep excluding it — verify before deploying).

**Definition of done:** `USER_GUIDE.md` exists, matches the shipped UI exactly, covers export → dedupe → review → verify → safe re-import, a non-technical reader could follow it end-to-end, and any app changes are proven by the three verification commands above.

--- END PROMPT ---

---

## 3. Reference for the next session (not part of the prompt)

**Real contact files (READ-ONLY — never modify, move, or delete):**
- Master: `/Users/iamtheking/Documents/Contacts/ALLSynologyContactsSep292025.vcf`
- iPhone (mixed export): `/Users/iamtheking/Documents/Contacts/All iPhone Contacts.vcf`
- That folder also contains older test artifacts from prior sessions (`TEST *.vcf`, `FIRST_GOOD_merged_contacts.vcf`) — leave them alone; they are Philip's.

**Engine API (for revisions):** `parseVCards(text)`, `findDuplicateGroups(contacts, {threshold})` → `{groups, unique}` (groups carry both `members` and an aliased `contacts` array — do not remove either), `mergeContacts(contacts)`, `contactToVCard(contact)`, `buildExport(groups, unique)` → `{contacts, vcfText}`, `generateCSV/generateJSON(contacts)`, `generateAuditLog(groups, stats)`, `noteIntegrityReport(before, after)`. `autoMergeSafe` = confidence ≥ 90 + email/phone evidence + zero warnings; name-only matches are deliberately review-only ("balanced" posture chosen by Philip).

**Environment gotcha:** `/Users/iamtheking/package.json` (unrelated project) sets `"type": "module"`, which breaks `require()` of `.js` files anywhere under the home directory. The project-root `package.json` (`"type": "commonjs"`) exists solely to shield this repo — do not delete it.

**Deploy:** `vercel --prod` from the project root (already linked). Only `index.html` + `engine.js` should ever ship — confirm `.vercelignore` is intact first.

**Logging:** per standing preference, drop this handoff and the finished guide into Philip's Obsidian vault at `/documents/projects/Vaults` if reachable (it wasn't during the rebuild session), and read the vault's `claude.md` if present.
