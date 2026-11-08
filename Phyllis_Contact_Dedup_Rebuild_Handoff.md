# HANDOFF: Rebuild and Verify the Contact Deduplication Application

**Client:** Phyllis Cath tech support
**Prepared:** July 24, 2026
**For:** The next session (human or Claude) that will rebuild and verify the contact deduplication tool
**Related project docs:** `Technology manual.docx`, `PHYLLIS HANDOFF 03262026.pdf`, `PHYLLIS HANDOFF 03142026.pdf`, `Handoff 3/14`, `Phyllis_Cath_Tech_Handoff.pdf`

---

## 1. Mission for this session

Rebuild the contact deduplication application that was previously used on Phyllis's Outlook / Synology contacts, and verify that the rebuilt version works correctly and safely. The prior version had a serious known defect: while merging duplicate contacts it **stripped many of the multi-line notes** off contacts. That defect is the reason a pre-dedup snapshot is still kept around today and notes are being copied back by hand.

The single most important success criterion for the rebuild is: **deduplicate contacts without losing any note content** (especially multi-line notes). Everything else is secondary to that.

Two deliverables from the session:

1. A rebuilt, working dedup tool whose logic and behavior are understood and documented.
2. A verification record proving the tool merges duplicates correctly and preserves all notes and fields, with a tested backup/rollback path.

---

## 2. Essential background: how contacts actually work in this environment

You cannot safely rebuild the dedup tool without understanding where contacts live and how they propagate, because deduplication touches the master store and any change fans out to every device. Here is the topology, drawn from the Technology manual.

- The contact data lives in **Outlook** on two Windows machines: the **iBuyPower tower (IBP / "IBP2")** and the **Dell XPS 13 laptop**. The live store is the Outlook Data File on those machines.
- Synchronization is handled by **Synology Contacts**, which is the Synology DiskStation's implementation of **CardDAV** (an open standard contact-sync protocol). The NAS is the hub.
- In Outlook, an add-in called **CalDav Synchronizer** is what actually pushes/pulls contacts between Outlook and the Synology Contacts CardDAV server. It runs on both the IBP and the Dell.
- The **iPhones and the iPad** sync the same contact list natively (iOS supports CardDAV directly).
- All of this is configured under the **CathAdmin** account on the Synology (DSM). Synology Contacts can be opened from the DSM main menu or from a desktop icon on the IBP and Dell, **but the manual explicitly warns that editing contacts inside the Synology Contacts DSM interface can cause data damage. It is for viewing only.**

**Why this matters for dedup:** because the sync is bidirectional through CardDAV, a merge or delete performed in one place propagates to the NAS and then out to every phone, tablet, and the other PC. A buggy dedup run does not damage one copy, it damages all of them. This is exactly how the multi-line notes got stripped everywhere last time.

### The pre-dedup snapshot (your safety reference and your test oracle)

There is a preserved copy of the contacts as they existed **before** the last dedup run:

- File: **`Outlook File for Note Copying.pst`**
- Location: **`C:\Users\pjcat\Documents\Outlook Files`** (on the IBP)
- It is opened in Outlook via `File > Open & Export > Open Outlook Data File`.
- It still contains **many duplicates** and, critically, **the full original multi-line notes** that the old utility stripped.

Today the workaround is fully manual: someone opens a contact in this old PST, copies the Notes text, finds the same contact in the live Outlook Data File, and pastes it back (procedure documented in the Technology manual). This PST is gold for two reasons: it is the ground-truth "before" state, and it is the source the rebuilt tool may need to draw correct notes from.

---

## 3. FIRST STEP OF THE SESSION: locate the existing utility

We are treating this as a rebuild of existing code, not a greenfield build. **Before writing anything, find the prior utility and read it.** Its logic (how it decided two contacts were duplicates, how it merged fields, and where the note-stripping bug lived) is the most valuable input you have. Do not reinvent the dedup criteria if the originals can be recovered and corrected.

Candidate locations to search, in rough priority order:

1. **Philip's Obsidian vaults:** `/documents/projects/Vaults` (per standing preference, all prior work is logged here). Search the vault for "dedup", "deduplication", "contacts", "vCard", "Outlook contacts", "notes". This was NOT reachable in the session that produced this handoff (no folder connected / path not present in the cloud sandbox), so it must be checked at session start.
2. **The Phyllis machines themselves:** IBP (`C:\Users\pjcat\`), the Dell, and the Mac (`/Users/phylliscath/`). Look in Documents, Desktop, Downloads, and any `Scripts` / `Tools` folders. The utility may be a loose `.py`, `.ps1`, `.vbs`, `.bas`/Outlook VBA macro, or a small app.
3. **The Synology NAS** (PJServer): the `Phyllis Word` content and `SynologyShare` (403 GB dumping ground) may contain a copy. Also check `homes/Phyllis/`.
4. **Any git repo or cloud storage** Philip used (Dropbox is installed on Dell and Mac).
5. **Prior chat/Cowork history** with Philip, since Cowork was used earlier in this engagement.

Questions to answer once you find it (or to ask Philip if you cannot):

- What language/platform is it (Python, PowerShell, Outlook VBA/COM, something else)?
- What input did it operate on: the live Outlook store via COM, an exported vCard/CSV, or the CardDAV server directly?
- How did it decide two contacts were duplicates (name match, email match, phone match, fuzzy match)?
- How did it merge fields, and specifically what did it do with the Notes field? That is where the bug was.
- Where and how was it run (which machine, manually or scheduled)?

**If the code truly cannot be recovered,** fall back to a from-scratch build using the requirements in Section 5, and use the pre-dedup PST plus the current live contacts to reverse-engineer what "correct" looks like.

---

## 4. The known defect (what "fixed" means)

The old tool's fatal flaw: during merge it discarded multi-line notes. A plausible root cause to check for (and guard against) is that it treated the Notes field as a single line, or took the note from the "wrong" duplicate (for example the emptier record won), or truncated at the first line break. Whatever the mechanism, the rebuilt tool must guarantee:

- No note content is ever deleted or truncated during a merge.
- When two duplicates both have notes, the merge **combines** them (or keeps the longer/richer one and appends the other with a separator), rather than picking one and dropping the other.
- Multi-line formatting and line breaks survive intact.

This is the acceptance bar. A rebuilt tool that merges perfectly but loses one line of one note has failed the core requirement.

---

## 5. Requirements for the rebuilt tool

Method and tech stack are intentionally left to the coder who takes this on. Section 6 sketches the main approaches and their tradeoffs so that decision can be made deliberately. Regardless of approach, the tool must meet these requirements.

**Functional**

- Detect duplicate contacts using clearly defined, documented rules (and ideally configurable ones, since name-only matching is too loose and email-only is too strict).
- Merge duplicates into a single record that is a **superset** of the fields across all matched duplicates: no field value silently lost, and above all no note content lost.
- Preserve every standard field: name components, all email addresses, all phone numbers, company, addresses, and the full Notes body.
- Be **idempotent**: running it twice should not corrupt data or re-merge already-merged records.

**Safety and operability (non-negotiable given the sync topology)**

- **Back up before any write.** Export the full current contact set (PST export and/or a vCard/CSV dump) and store it with a timestamp before the tool touches anything.
- **Dry-run mode.** The tool must be able to produce a full report of what it *would* merge and delete, for human review, without changing anything.
- **Audit log.** Every merge and delete written to a log: which records were combined, which survived, what the resulting Notes field is.
- **Reversibility.** A clear, tested path to restore the pre-run state if something goes wrong.
- Operate against a **single authoritative copy** and let CardDAV propagate, rather than running independently on multiple machines (running it in parallel on IBP and Dell would create conflicts).

**Given Philip's stated preference for the more robust/advanced solution over the minimal one:** favor a design that produces a reviewable merge plan, keeps an audit trail, and can be re-run safely, even though a quick throwaway script could technically dedupe in one pass. The extra structure is what prevents a repeat of the notes-loss incident.

---

## 6. Approach options and tradeoffs (for the coder to choose)

**Option A: Python operating on exported vCards / CSV (offline).**
Export contacts from Outlook or Synology Contacts to vCard (.vcf) or CSV, run a standalone Python tool that dedupes and merges into a clean output file, then import the result back.
Strengths: fully testable offline against a copy, no live-store risk during development, easy to unit test note-preservation logic, portable, uses mature libraries (for example `vobject` for vCard). Best fit for a careful, verifiable rebuild.
Weaknesses: the export/import round trip can itself drop or reformat fields, so the import step needs its own verification. Requires a clean way to get data out and back in.

**Option B: Direct Outlook automation (COM via Python `pywin32`, or PowerShell, or Outlook VBA).**
Operate directly on the live Outlook contact store on one PC.
Strengths: closest to where the data actually lives, no export/import fidelity loss, can read/write the exact Notes field Outlook stores.
Weaknesses: harder to test safely (you are touching the real store), Windows-only, tied to Outlook being installed and configured, COM automation is fiddly. Higher risk if run without a solid dry-run and backup.

**Option C: Operate on the CardDAV server (Synology Contacts) directly.**
Talk to the CardDAV endpoint on the NAS.
Strengths: single source of truth, changes propagate naturally.
Weaknesses: the manual warns editing in Synology Contacts can cause data damage, and doing dedup at this layer is the riskiest place to get it wrong because it is the fan-out hub. Least recommended for the actual merge writes.

A reasonable hybrid many would pick: **develop and verify with Option A against exported copies** (safe, testable), then decide whether to import the cleaned result back through Outlook (Option B path) as the single authoritative write, letting CardDAV sync it out. The coder should confirm the round-trip preserves notes before trusting it.

---

## 7. Verification plan (the "verify" half of the mission)

Verification is not optional and is half the reason this session exists. Build the tool and prove it.

1. **Assemble a test dataset.** Use a copy of the real pre-dedup data (the `Outlook File for Note Copying.pst` is ideal because it is full of real duplicates and real multi-line notes). Never test against the live store.
2. **Note-integrity check (the critical one).** For every contact that has notes before dedup, confirm all of that note text is present in the merged output afterward. Concretely: compare total note character count and line count per merged identity before and after, and confirm nothing shrank unexpectedly. Any loss is a fail.
3. **Field-preservation check.** Confirm all emails, phones, and addresses from all duplicates survive into the merged record.
4. **Count sanity check.** Record contact count before and after. The drop should equal the number of duplicates removed and no more. Investigate any unexpected reduction.
5. **Idempotency check.** Run the tool a second time on its own output. It should find nothing to merge and change nothing.
6. **Spot check with Philip / Phyllis.** Pick a handful of known contacts (including ones with long notes) and eyeball them. Note that "Fix Outlook contacts view" is a standing pending item that must be done with Phyllis present, so plan any live-store work for a time she is available.
7. **Backup/rollback rehearsal.** Before any run against real data, prove you can restore the pre-run export. Actually test the restore, do not just assume it works.
8. **Propagation test (only after the above pass).** If/when the cleaned data is written to the live store, modify or confirm one contact and verify the change appears correctly on the NAS and on a phone, confirming CardDAV is behaving.

Definition of done: the tool merges the test set with zero note loss and zero field loss, is idempotent, has a working backup/restore, and Philip has seen the dry-run merge plan and approved it before any live write.

---

## 8. Critical warnings and gotchas

- **Contacts sync is bidirectional and fans out to every device.** A bad merge or delete propagates to the NAS and all phones/tablets. Treat every write as a fleet-wide change. This is how the notes were lost everywhere last time.
- **Do not edit contacts inside the Synology Contacts DSM interface.** The manual says it can cause data damage. View only.
- **Back up before touching anything.** Timestamped export first, every time.
- **Do not run the tool on IBP and Dell simultaneously.** Pick one authoritative machine and let CardDAV propagate, or you will create merge conflicts.
- **The pre-dedup PST is precious.** Do not overwrite or delete `Outlook File for Note Copying.pst`. It is both the safety net and the correct-notes source.
- **Confirm which machine you are on before acting.** A recurring lesson across these handoffs is confusion between IBP2, Dell, and Mac. Always confirm.
- **Some steps require Phyllis present** (notably the Outlook contacts view fix). Schedule accordingly.
- **Watch the export/import round trip** for silent field reformatting or note truncation; verify it explicitly rather than trusting it.

---

## 9. Environment and access reference

Pulled from the Technology manual; confirm live values at session start since some may have changed.

**Machines**

- **IBP / IBP2** (iBuyPower tower): Windows 10 Pro, local admin account `pjcat`, PIN 1974. Holds the live Outlook store and the `Outlook Files` folder with the pre-dedup PST. Path root: `C:\Users\pjcat\`.
- **Dell XPS 13 7390** (svc tag HSBP3X2): Windows 10 Pro, local admin `pjcat`, PIN 1974. Second Outlook store, also runs CalDav Synchronizer.
- **DellBasement** (OptiPlex 3090, svc tag CDN1RN3): Windows 11 Pro, local admin `pjcath`, PIN 1974.
- **Mac** (MacBook): user `phylliscath`, home `/Users/phylliscath/`. Phyllis actively works here (for documents; contacts sync via iOS/CardDAV ecosystem).

**Synology NAS**

- System name **PJServer**, model DS418play, DSM 7.1.1. Managed under the **CathAdmin** account.
- Reachable on the LAN around `192.168.1.204` (DSM was noted at `192.168.1.204:8001` in the 3/26 handoff; confirm current port/IP).
- Runs **Synology Contacts** (the CardDAV server) plus Drive Server, Active Backup for Business, and Surveillance Station.

**Contacts-specific paths and components**

- Live store: Outlook Data File on IBP and Dell.
- Pre-dedup snapshot: `C:\Users\pjcat\Documents\Outlook Files\Outlook File for Note Copying.pst` (IBP).
- Sync add-in: **CalDav Synchronizer** inside Outlook on IBP and Dell.
- Credentials note: IBP's `pjcat` account is Microsoft-linked; a local account named `PhyllisShare` is used for network authentication. Stale mapped drives and cached credentials in Windows Credential Manager have caused network issues before, check there if SMB access misbehaves.

(Passwords are not reproduced in this doc. Get them from Philip or the credential store at session start.)

---

## 10. Open questions to confirm with Philip at the start

1. Where does the original dedup utility live, and what language/platform is it? (Drives whether this is a true rebuild or a from-scratch build.)
2. On which machine and against which store did the old tool run?
3. Is the goal to fully re-dedup the current live contacts, or to build the tool now and run it later under supervision?
4. How aggressive should duplicate matching be (exact email match only, or fuzzy name matching)? What is the tolerance for a false merge versus a missed duplicate?
5. Should the tool also help automate the note-restoration from the old PST, or is that a separate task?
6. Preferred authoritative machine for the eventual live run.

---

## 11. Logging note

Per standing preference, this work should be logged into the Obsidian vault at `/documents/projects/Vaults`. That location was not reachable from the sandbox in the session that produced this handoff, so it has not been written there yet. The next session (or Philip) should drop this handoff and the rebuild notes into the vault, and read the vault's `claude.md` at the start.
