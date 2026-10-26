#!/usr/bin/env node
// Convert any contacts export into files DeDupe Pro reads — WITHOUT printing any contact content.
//
//   node tools/convert-contacts.mjs <file> [--out-dir <dir>]
//
// Input: Outlook / Google / generic .csv or .tsv (UTF-8, UTF-16, Windows-1252), .vcf, .xlsx/.xls,
//        or an Outlook .pst/.ost (needs `readpst`: brew install libpst).
// Output (next to the input unless --out-dir):
//   <name>.CONVERTED.vcf               → load this into DeDupe Pro
//   <name>.CONVERTED-for-Outlook.csv   → same contacts in Outlook's own CSV columns
//
// Only aggregate numbers, the detected format/encoding and COLUMN HEADER NAMES are printed. No names,
// emails, phones, addresses or notes ever reach the terminal, so this is safe to run through an AI
// assistant without it seeing the contact list. Uses the exact engine embedded in index.html.

import { readFileSync, writeFileSync, mkdtempSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, extname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const src = html.split('// ENGINE-START')[1].split('// ENGINE-END')[0];
const E = new Function(src + `
  return { parseVCards, parseContactFile, parseContactRows, decodeContactFile, sniffFileKind, contactToVCard,
           writeOutlookCSV, encodeOutlookCSV, noteCharCount, normalizeEmail, normalizePhone, suspectTruncatedNotes, parseCSV };`)();

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out-dir');
const outDirArg = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const input = args[0];
if (!input) { console.error('Usage: node tools/convert-contacts.mjs <contacts file> [--out-dir <dir>]'); process.exit(2); }
const inPath = resolve(input);
if (!existsSync(inPath)) { console.error('File not found.'); process.exit(2); }

const bytes = readFileSync(inPath);
const kind = E.sniffFileKind(bytes, inPath);
const label = basename(inPath, extname(inPath));
let parsed, encoding = '', how = '';

try {
  if (kind === 'pst') {
    let readpst;
    try { readpst = execFileSync('which', ['readpst']).toString().trim(); } catch { throw new Error('readpst is not installed. Run: brew install libpst'); }
    const tmp = mkdtempSync(join(tmpdir(), 'pst-'));
    try {
      try { execFileSync(readpst, ['-t', 'c', '-8', '-q', '-r', '-o', tmp, inPath], { stdio: ['ignore', 'ignore', 'pipe'] }); }
      catch { throw new Error('readpst could not read this .pst. Close Outlook (it locks the file) or copy the .pst first, then try again.'); }
      const files = [];
      const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : files.push(p); } };
      walk(tmp);
      const vcf = files.map(f => readFileSync(f, 'utf8')).filter(t => /BEGIN:VCARD/i.test(t)).join('\r\n');
      if (!vcf) throw new Error('No contacts found in the .pst (readpst found no contact items).');
      parsed = { format: 'vcf', contacts: E.parseVCards(vcf, label) };
      how = `Outlook data file (.pst) via readpst, ${files.length} folder file(s)`;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  } else if (kind === 'xlsx' || kind === 'xls') {
    const py = `import json,sys,openpyxl
wb=openpyxl.load_workbook(sys.argv[1],read_only=True,data_only=True)
for ws in wb.worksheets:
  rows=[["" if v is None else str(v) for v in r] for r in ws.iter_rows(values_only=True)]
  if len(rows)>1:
    json.dump(rows,sys.stdout); break`;
    if (kind === 'xls') throw new Error('Old .xls files: open in Excel and Save As "CSV UTF-8 (Comma delimited)", then run this again.');
    const out = execFileSync('python3', ['-c', py, inPath], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
    if (!out) throw new Error('The spreadsheet is empty.');
    parsed = E.parseContactRows(JSON.parse(out), label, ',');
    encoding = 'xlsx'; how = 'Excel workbook';
  } else if (kind === 'text') {
    const d = E.decodeContactFile(bytes);
    encoding = d.encoding;
    parsed = E.parseContactFile(d.text, label);
    how = parsed.format === 'vcf' ? 'vCard file' : (parsed.mapping.native ? 'Outlook CSV export' : 'contacts spreadsheet (CSV)');
  } else {
    throw new Error(`This is a .${kind} file, which isn't a contacts export. Export the Contacts folder from Outlook as Comma Separated Values.`);
  }
} catch (err) {
  console.error('FAILED: ' + err.message);
  process.exit(1);
}

const all = parsed.contacts;
const live = all.filter(c => !c.empty);
const sum = (f) => live.reduce((s, c) => s + f(c), 0);
const stats = cs => ({
  contacts: cs.length,
  withEmail: cs.filter(c => c.emails.length).length,
  withPhone: cs.filter(c => c.phones.length).length,
  withNotes: cs.filter(c => c.notes).length,
  noteChars: cs.reduce((s, c) => s + E.noteCharCount(c.notes), 0),
  emails: cs.reduce((s, c) => s + c.emails.length, 0),
  phones: cs.reduce((s, c) => s + c.phones.length, 0),
  addresses: cs.reduce((s, c) => s + c.addresses.length, 0),
});
const before = stats(live);

const outDir = outDirArg ? resolve(outDirArg) : dirname(inPath);
const vcfPath = join(outDir, `${label}.CONVERTED.vcf`);
const csvPath = join(outDir, `${label}.CONVERTED-for-Outlook.csv`);
const vcfText = live.map(E.contactToVCard).join('');
writeFileSync(vcfPath, vcfText, 'utf8');
const native = parsed.mapping && parsed.mapping.native;
const csvEnc = E.encodeOutlookCSV(E.writeOutlookCSV(live, native ? parsed.header : null, native ? parsed.delimiter : ','), encoding === 'windows-1252' ? 'windows-1252' : 'utf-8');
writeFileSync(csvPath, csvEnc.bytes);

// Verify: re-read both outputs with the same engine and compare aggregates.
const after = stats(E.parseVCards(readFileSync(vcfPath, 'utf8'), 'check').filter(c => !c.empty));
const csvBack = E.parseContactFile(E.decodeContactFile(readFileSync(csvPath)).text, 'check');
const afterCsv = stats(csvBack.contacts.filter(c => !c.empty));
// Value-level check of the Outlook CSV: every email and phone of contact i must appear in row i
// (in its column, or in Notes when Outlook has no free column for it); notes must be contained whole.
const csvRows = E.parseCSV(E.decodeContactFile(readFileSync(csvPath)).text.replace(/^\uFEFF/, ''), native ? parsed.delimiter : ',').slice(1);
let csvMissing = 0, notesMissing = 0;
live.forEach((c, i) => {
  const r = (csvRows[i] || []).join('\u0001');
  const ws = t => t.toLowerCase().replace(/\s+/g, ' ');   // line breaks inside a phone cell become spaces
  const lower = ws(r), digits = r.replace(/\D/g, '');
  for (const e of c.emails) if (!lower.includes(ws(e))) csvMissing++;
  for (const p of c.phones) { const d = E.normalizePhone(p); if (d ? !digits.includes(d) : !lower.includes(ws(p).trim())) csvMissing++; }
  if (c.notes && !r.replace(/\r\n/g, '\n').includes(c.notes.replace(/\r\n?/g, '\n'))) notesMissing++;
});

const line = (k, v) => console.log(`  ${k.padEnd(28)} ${v}`);
console.log(`Input:  ${basename(inPath)}  (${(bytes.length / 1024 / 1024).toFixed(1)} MB)`);
line('Detected', `${how}${encoding && encoding !== 'xlsx' ? ', encoding ' + encoding : ''}${parsed.delimiter && parsed.format === 'csv' ? `, delimiter ${JSON.stringify(parsed.delimiter)}` : ''}`);
if (parsed.mapping) {
  const m = parsed.mapping;
  line('Columns', `${m.columns} total, ${m.recognised} recognised${m.native ? ' (standard Outlook columns)' : ''}`);
  if (m.mapped.length) line('Renamed columns', m.mapped.slice(0, 12).join('; ') + (m.mapped.length > 12 ? ` … +${m.mapped.length - 12}` : ''));
  if (m.slotColumns) line('Numbered columns', `${m.slotColumns} (e.g. "Phone 1 - Value") turned into fields`);
  if (m.extras.length) line('Kept as extra fields', m.extras.slice(0, 12).join('; ') + (m.extras.length > 12 ? ` … +${m.extras.length - 12}` : ''));
  const missing = [!m.hasEmail && 'email', !m.hasPhone && 'phone', !m.hasNotes && 'notes'].filter(Boolean);
  if (missing.length) line('WARNING', `no ${missing.join(' / ')} column found — check the export`);
}
line('Rows/cards read', `${all.length} (${all.length - live.length} empty skipped)`);
line('Contacts', before.contacts);
line('With email / phone / notes', `${before.withEmail} / ${before.withPhone} / ${before.withNotes}`);
line('Total emails / phones / addr', `${before.emails} / ${before.phones} / ${before.addresses}`);
line('Total note characters', before.noteChars);
const cut = E.suspectTruncatedNotes(live);
if (cut) line('WARNING', `${cut} notes are exactly 255 characters — the export may have cut notes short`);
const ok1 = after.contacts === before.contacts && after.noteChars === before.noteChars && after.emails === before.emails && after.phones === before.phones && after.addresses === before.addresses;
const ok2 = afterCsv.contacts === before.contacts && csvRows.length === live.length && csvMissing === 0 && notesMissing === 0;
console.log(`Output: ${vcfPath}`);
line('Re-read check', ok1 ? 'OK — same contacts, emails, phones, addresses and note characters' : `MISMATCH ${JSON.stringify({ before, after })}`);
console.log(`Output: ${csvPath}`);
line('Re-read check', ok2 ? `OK — ${csvEnc.encoding}; every email, phone and note is in the file (values with no free Outlook column were added to Notes)` : `PROBLEM — ${csvMissing} email/phone values and ${notesMissing} notes not found in the CSV; use the .vcf instead`);
process.exit(ok1 && ok2 ? 0 : 3);
