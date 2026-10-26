#!/usr/bin/env node
// Runs the REAL engine code from index.html (between ENGINE-START / ENGINE-END)
// against fixtures, then optionally against a real export (pass a path as argv[2]).
//
//   node tests/test_engine.mjs
//   node tests/test_engine.mjs ~/Documents/Contacts/ALLSynologyContactsSep292025.vcf

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'index.html'), 'utf8');
const src = html.split('// ENGINE-START')[1].split('// ENGINE-END')[0];
// Expose engine functions on a namespace object.
const E = new Function(src + `
  return { parseVCards, findDuplicateGroups, mergeContacts, contactToVCard, calculateConfidence, checkNoteIntegrity,
           checkFieldIntegrity, uniqueNotes, combineNotes, noteCharCount, escapeVCardValue, unescapeVCardValue,
           normalizePhone, normalizeEmail, nameVariants, pickBestName, titleCase, NOTE_SEP, MERGE_FOOTER_HEAD,
           decodeContactFile, parseContactFile, parseCSV, writeOutlookCSV, encodeOutlookCSV, buildOutlookRow,
           suspectTruncatedNotes, OUTLOOK_DEFAULT_HEADER, parseContactRows, sniffFileKind };`)();

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓', name); }
  catch (e) { failed++; console.log('  ✗', name); console.log('     ', e.message.split('\n').slice(0, 6).join(' | ')); }
}
const card = (fields) => 'BEGIN:VCARD\r\nVERSION:3.0\r\n' + fields.join('\r\n') + '\r\nEND:VCARD\r\n';

console.log('Note safety');
test('multi-line note escape round-trips', () => {
  const original = 'Line one\nLine two\nLine three with comma, and; semicolon \\ backslash';
  const escaped = E.escapeVCardValue(original);
  assert.ok(!escaped.includes('\n'));
  assert.equal(E.unescapeVCardValue(escaped), original);
});
test('multiple NOTE properties on one card are all kept', () => {
  const [c] = E.parseVCards(card(['FN:Two Notes', 'NOTE:Note A with\\; semicolon', 'NOTE:Note B second property']));
  assert.ok(c.notes.includes('Note A with; semicolon'));
  assert.ok(c.notes.includes('Note B second property'));
});
test('folded long NOTE is unfolded and preserved', () => {
  const text = 'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Folded\r\nNOTE:First paragraph\\n\\nSecond para\r\n graph continues here\\, with comma.\r\nEND:VCARD\r\n';
  const [c] = E.parseVCards(text);
  assert.equal(c.notes, 'First paragraph\n\nSecond paragraph continues here, with comma.');
});
test('merge combines unique notes; a note contained in another is not duplicated', () => {
  const a = E.parseVCards(card(['FN:Amy Smith', 'EMAIL:amy@x.com', 'NOTE:Long note\\nwith lines']))[0];
  const b = E.parseVCards(card(['FN:Amy Smith', 'EMAIL:amy@x.com', 'NOTE:Long note']))[0];
  const c = E.parseVCards(card(['FN:Amy Smith', 'EMAIL:amy@x.com', 'NOTE:Totally different']))[0];
  const m = E.mergeContacts([a, b, c]);
  assert.equal(m.notes, 'Long note\nwith lines' + E.NOTE_SEP + 'Totally different');
  const src = E.uniqueNotes([a.notes, b.notes, c.notes]).reduce((s, n) => s + E.noteCharCount(n), 0);
  assert.ok(E.noteCharCount(m.notes) >= src);
});
test('exported merged NOTE re-parses to the identical note text', () => {
  const a = E.parseVCards(card(['FN:Bob Jones', 'TEL:415-555-0100', 'NOTE:Para one\\n\\nPara two\\, has comma\\; and semi']))[0];
  const b = E.parseVCards(card(['FN:Bob Jones', 'TEL:(415) 555-0100', 'NOTE:Other note']))[0];
  const m = E.mergeContacts([a, b]);
  const [re] = E.parseVCards(m.vcard);
  assert.equal(re.notes, m.notes);
  assert.ok(m.notes.includes('Para one\n\nPara two, has comma; and semi'));
});
test('integrity gate flags a merge whose notes were shortened by an edit', () => {
  const a = E.parseVCards(card(['FN:Cara Lee', 'EMAIL:cara@x.com', 'NOTE:Keep this whole note please']))[0];
  const b = E.parseVCards(card(['FN:Cara Lee', 'EMAIL:cara@x.com']))[0];
  const g = { id: 0, contacts: [a, b], status: 'approved', merged: E.mergeContacts([a, b], { notes: 'Keep' }) };
  assert.equal(E.checkNoteIntegrity([g]).ok, false);
  g.merged = E.mergeContacts([a, b]);
  assert.equal(E.checkNoteIntegrity([g]).ok, true);
});

console.log('Field safety (superset merge)');
test('addresses, phone labels, photo, categories and URL all survive a merge', () => {
  const a = E.parseVCards(card(['FN:Thornley\\, Andy', 'N:Thornley;Andy;;;', 'EMAIL;TYPE=INTERNET,HOME:andy@sfmta.com', 'TEL;TYPE=WORK:(415) 701-4213', 'ADR;TYPE=HOME:;;1 South Van Ness;San Francisco;CA;94103;', 'CATEGORIES:Professional', 'ORG:MTA']))[0];
  const b = E.parseVCards(card(['FN:MTA\\, Andy Thornley', 'EMAIL:Andy@SFMTA.com', 'TEL;TYPE=CELL:+1 415 244 4605', 'URL:https://sfmta.com', 'PHOTO;ENCODING=b;TYPE=JPEG:/9j/AAAA', 'CATEGORIES:QuickList', 'ORG:Skoots']))[0];
  const m = E.mergeContacts([a, b]);
  const v = m.vcard;
  assert.equal(m.emails.length, 1, 'same email deduped case-insensitively');
  assert.equal(m.phones.length, 2);
  assert.ok(v.includes('TEL;TYPE=WORK:(415) 701-4213'));
  assert.ok(v.includes('TEL;TYPE=CELL:+1 415 244 4605'));
  assert.ok(v.includes('ADR;TYPE=HOME:;;1 South Van Ness'));
  assert.ok(v.includes('URL:https://sfmta.com'));
  assert.ok(v.includes('PHOTO;ENCODING=b;TYPE=JPEG:/9j/AAAA'));
  assert.ok(/CATEGORIES:(Professional,QuickList|QuickList,Professional)/.test(v));
  // the losing ORG is recorded in the notes footer, not dropped
  assert.ok(m.notes.includes(E.MERGE_FOOTER_HEAD));
  assert.ok(/Company: (MTA|Skoots)/.test(m.notes));
  assert.equal(E.checkFieldIntegrity([{ id: 0, contacts: [a, b], status: 'approved', merged: m }]).ok, true);
});
test('alternate names carrying extra words are kept in the notes footer', () => {
  const a = E.parseVCards(card(['FN:holmes\\, al', 'EMAIL:al@x.com']))[0];
  const b = E.parseVCards(card(['FN:Handyman\\, Al Holmes', 'EMAIL:al@x.com']))[0];
  const m = E.mergeContacts([a, b], { name: 'holmes, al' });
  assert.ok(m.notes.includes('Also listed as: Handyman, Al Holmes'));
});
test('messy EMAIL values are cleaned: display names stripped, lists split, duplicates dropped', () => {
  const [c] = E.parseVCards(card(['FN:Amy S', 'EMAIL:Amy Samaniego <amy.s@sutterhealth.org>', 'EMAIL:amy.s@sutterhealth.org', 'EMAIL:AMY.S@SutterHealth.org', 'EMAIL:a@x.com\\, b@y.com', 'EMAIL:www.example.com']));
  assert.deepEqual(c.emails, ['amy.s@sutterhealth.org', 'a@x.com', 'b@y.com', 'www.example.com']);
});
test('identical phones within one card are collapsed', () => {
  const [c] = E.parseVCards(card(['FN:Jamie Fowler', 'TEL;TYPE=CELL:(415) 555-0199', 'TEL;TYPE=HOME:+1 (415) 555-0199', 'TEL:415.555.0199']));
  assert.equal(c.phones.length, 1);
});
test('export is CRLF-only, lines are folded at 75 chars, and untouched cards round-trip byte-for-byte', () => {
  const raw = card(['FN:Long Note', 'NOTE:' + 'x'.repeat(300)]);
  const [c] = E.parseVCards(raw);
  assert.equal(E.contactToVCard(c), raw);
  const m = E.mergeContacts([c, E.parseVCards(card(['FN:Long Note', 'NOTE:another']))[0]]);
  assert.ok(!/[^\r]\n/.test(m.vcard), 'CRLF only');
  assert.ok(m.vcard.split('\r\n').every(l => l.length <= 75), 'folded');
  assert.equal(E.parseVCards(m.vcard)[0].notes, m.notes);
});
test('the majority spelling wins by default; the reviewer can override', () => {
  const cards = ['Nellie Boykoff', 'Amy Samaniego and Nellie Boykoff', 'Nellie Boykoff', 'nellie boykoff'].map(n => E.parseVCards(card(['FN:' + n, 'TEL:415-555-0101']))[0]);
  assert.equal(E.pickBestName(cards), 'Nellie Boykoff');
  assert.equal(E.mergeContacts(cards, { name: 'Boykoff, Nellie' }).name, 'Boykoff, Nellie');
  assert.equal(E.titleCase('nellie boykoff'), 'Nellie Boykoff');
});
test('empty Apple placeholder cards are flagged, not silently dropped', () => {
  const list = E.parseVCards('BEGIN:VCARD\r\nVERSION:3.0\r\nPRODID:-//Apple Inc.//iPhone OS 18.6.2//EN\r\nN:;;;;\r\nEND:VCARD\r\n');
  assert.equal(list.length, 1);
  assert.equal(list[0].empty, true);
});

console.log('Matching');
const P = (fields) => E.parseVCards(card(fields))[0];
test('same email + same name is a sure thing (>= 95, no warnings)', () => {
  const r = E.calculateConfidence(P(['FN:Cohen\\, Alan', 'EMAIL:acskoot@aol.com']), P(['FN:Cohen\\, Mr. Alan', 'EMAIL:acskoot@aol.com']));
  assert.ok(r.score >= 95, 'score ' + r.score);
  assert.equal(r.warnings.length, 0);
});
test('household: same last name + shared home phone stays under the 50% floor', () => {
  const r = E.calculateConfidence(P(['FN:Schuman\\, Allan', 'N:Schuman;Allan;;;', 'TEL:(415) 608-8284']), P(['FN:Schuman\\, Lynne', 'N:Schuman;Lynne;;;', 'TEL:(415) 608-8284']));
  assert.ok(r.score < 50, 'score ' + r.score);
});
test('shared toll-free number with unrelated names is only a weak hint', () => {
  const r = E.calculateConfidence(P(['FN:USAA\\, Cindy Mapes', 'TEL:(800) 531-8722']), P(['FN:Bank of the West', 'TEL:1-800-531-8722']));
  assert.ok(r.score < 40, 'score ' + r.score);
  assert.ok(r.warnings.some(w => /toll-free/i.test(w)));
});
test('nickname + shared phone matches', () => {
  const r = E.calculateConfidence(P(['FN:Robert Smith', 'TEL:415 555 0123']), P(['FN:Bob Smith', 'TEL:(415) 555-0123']));
  assert.ok(r.score >= 80, 'score ' + r.score);
  assert.ok(r.factors.includes('Nickname match'));
});
test('"Last, First" and "First Last" spellings match each other', () => {
  const r = E.calculateConfidence(P(['FN:Fishbien\\, Jonathan', 'N:Fishbien;Jonathan;;;', 'EMAIL:gold.fish5@verizon.net']), P(['FN:Jonathan Fishbien', 'EMAIL:gold.fish5@verizon.net']));
  assert.equal(r.score, 100);
});
test('chained groups are flagged and never pre-approved', () => {
  // 1~2 by exact name (50); 2~3 by shared phone + same company (50); 1 and 3 share nothing.
  const list = [
    P(['FN:A Person', 'EMAIL:a@x.com']),
    P(['FN:A Person', 'TEL:415-555-2000', 'ORG:Acme']),
    P(['FN:Zed Other', 'TEL:415-555-2000', 'ORG:Acme', 'EMAIL:zed@y.com']),
  ];
  const { groups } = E.findDuplicateGroups(list, 50);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].contacts.length, 3);
  assert.equal(groups[0].chained, true);
  assert.ok(groups[0].warnings.some(w => /Chained/.test(w)));
});
test('crossOnly ignores pairs from the same file', () => {
  const a = P(['FN:Dup Person', 'EMAIL:d@x.com']); a.source = 'A';
  const b = P(['FN:Dup Person', 'EMAIL:d@x.com']); b.source = 'A';
  const c = P(['FN:Dup Person', 'EMAIL:d@x.com']); c.source = 'B';
  assert.equal(E.findDuplicateGroups([a, b], 60, { crossOnly: true }).groups.length, 0);
  assert.equal(E.findDuplicateGroups([a, c], 60, { crossOnly: true }).groups.length, 1);
});
test('second pass over merged output finds nothing at 95%+ (idempotent)', () => {
  const list = ['Cath\\, Sandra', 'Sandra Cath', 'Cath\\, Sandra Tahoe'].map(n => P(['FN:' + n, 'EMAIL:sandracath@gmail.com', 'TEL:(949) 636-0030', 'NOTE:note for ' + n]));
  const { groups } = E.findDuplicateGroups(list, 60);
  assert.equal(groups.length, 1);
  const m = E.mergeContacts(groups[0].contacts);
  const again = E.findDuplicateGroups(E.parseVCards(m.vcard), 60);
  assert.equal(again.groups.length, 0);
  const notes = E.parseVCards(m.vcard)[0].notes;
  for (const c of list) assert.ok(notes.includes(c.notes), 'kept note: ' + c.notes);
});
test('junk in an EMAIL field with an escaped newline cannot break the exported card', () => {
  const a = P(['FN:Amherst\\, Alumni', 'EMAIL:www.amherst.edu/it/acdata for scheduler\\r\\n542 2266', 'EMAIL:alumni@amherst.edu']);
  const b = P(['FN:Amherst Alumni', 'EMAIL:alumni@amherst.edu']);
  const m = E.mergeContacts([a, b]);
  assert.ok(!/[^\r]\n/.test(m.vcard), 'CRLF only');
  const [re] = E.parseVCards(m.vcard);
  assert.equal(re.emails.length, 2);
  assert.ok(re.emails.includes('alumni@amherst.edu'));
});

console.log('Outlook CSV');
const fixtureBytes = readFileSync(join(here, 'fixtures', 'outlook_export_cp1252.csv'));
const dec = E.decodeContactFile(fixtureBytes);
const parsed = E.parseContactFile(dec.text, 'Outlook');
const live = parsed.contacts.filter(c => !c.empty);
const byFirst = n => live.filter(c => c.nField && c.nField[1] === n);
test('Windows-1252 file is detected and decoded (accents, curly quotes, em dash intact)', () => {
  assert.equal(dec.encoding, 'windows-1252');
  assert.equal(parsed.format, 'csv');
  const jose = byFirst('José')[0];
  assert.ok(jose, 'José parsed');
  assert.equal(jose.nField[0], 'Núñez');
  assert.equal(jose.org, 'Café "Olé", Inc.');
  assert.equal(jose.notes, 'Prefers “text” — not email.\nSpouse: Renée');
});
test('header is matched by name; filler rows (0/0/00, Normal, False) are empty', () => {
  assert.equal(parsed.contacts.length, 5);
  assert.equal(parsed.contacts.filter(c => c.empty).length, 1);
  assert.equal(byFirst('Nellie')[0].birthday, '');
  assert.equal(byFirst('Nellie')[1].birthday, '3/14/1955');
});
test('multi-line quoted Notes with embedded quotes and commas come through exactly', () => {
  assert.equal(byFirst('Nellie')[0].notes, 'Nurse is Aimee Samaniego\nCall before 10am, "ask for Griselle"\nCopay $40, no referral needed');
});
test('display-name duplicates are ignored and Exchange X.500 addresses resolve to SMTP', () => {
  assert.deepEqual(byFirst('Nellie')[0].emails, ['aimee.samaniego@sutterhealth.org']);
  assert.deepEqual(byFirst('Andy')[0].emails, ['andy.thornley@sfmta.com']);
});
test('duplicate Outlook rows group and merge with every column kept', () => {
  const { groups } = E.findDuplicateGroups(live, 60);
  assert.equal(groups.length, 1);
  const g = groups[0];
  assert.ok(g.confidence >= 95, 'confidence ' + g.confidence);
  g.merged = E.mergeContacts(g.contacts); g.status = 'approved';
  assert.ok(E.checkNoteIntegrity([g]).ok && E.checkFieldIntegrity([g]).ok);
  const row = E.buildOutlookRow(g.merged, parsed.header);
  const cell = name => row[parsed.header.indexOf(name)];
  assert.equal(cell('Department'), 'Neurology');
  assert.equal(cell("Assistant's Name"), 'Griselle Perkins');
  assert.equal(cell('Home Street'), '2100 Webster St\r\nSuite 423');
  assert.equal(cell('Home City'), 'San Francisco');
  assert.equal(cell('Home Postal Code'), '94115');
  assert.equal(cell('Mobile Phone'), '+1 (415) 260-4307');
  assert.equal(cell('E-mail Address').toLowerCase(), 'aimee.samaniego@sutterhealth.org');
  assert.equal(cell('E-mail 2 Address'), '');
  assert.equal(cell('Birthday'), '3/14/1955');
  const phones = [cell('Business Phone'), cell('Business Phone 2')].sort();
  assert.deepEqual(phones, ['(415) 600-3604', '(415) 600-7886']);
  assert.ok(cell('Notes').includes('Call before 10am, "ask for Griselle"\r\nCopay $40'));
  assert.ok(cell('Notes').includes('Headache clinic — 2019'));
  assert.deepEqual(cell('Categories').split(';').sort(), ['Doctors', 'Medical']);
});
test('untouched rows are written back with their original values, column for column', () => {
  const jose = byFirst('José')[0];
  assert.deepEqual(E.buildOutlookRow(jose, parsed.header), jose.csv.values);
  const text = E.writeOutlookCSV(live, parsed.header, ',');
  const rows = E.parseCSV(text, ',');
  assert.deepEqual(rows[0], parsed.header);
  assert.equal(rows.length, live.length + 1);
});
test('Windows-1252 output when lossless, UTF-8+BOM when a character cannot be represented', () => {
  const ok = E.encodeOutlookCSV('José — “ok”', 'windows-1252');
  assert.equal(ok.encoding, 'windows-1252');
  assert.equal(E.decodeContactFile(ok.bytes).text, 'José — “ok”');
  const cjk = E.encodeOutlookCSV('王小明', 'windows-1252');
  assert.equal(cjk.encoding, 'utf-8');
  assert.equal(new TextDecoder('utf-8').decode(cjk.bytes), '王小明');
});
test('a semicolon-delimited export (European Outlook) is read too', () => {
  const text = '"First Name";"Last Name";"E-mail Address";"Notes"\r\n"Ann";"Lee";"ann@x.com";"line 1\r\nline; 2"\r\n';
  const r = E.parseContactFile(text, 'eu');
  assert.equal(r.delimiter, ';');
  assert.equal(r.contacts[0].notes, 'line 1\nline; 2');
});
test('a CSV with no name/email/phone columns is rejected with a clear message', () => {
  assert.throws(() => E.parseContactFile('Date,Amount,Memo\n2026-01-01,3,x\n', 'x'), /Couldn't find a header row/);
});

test('a file with NO header row is rejected, and the error never contains cell contents', () => {
  const t = 'Jane Doe,jane@doe.example,Mobile,415-555-0199,Seeing Dr Smith\r\nJohn Roe,john@roe.example,,415-555-0100,x\r\n';
  let err;
  try { E.parseContactFile(t, 'nohdr'); } catch (e) { err = e; }
  assert.ok(err, 'should throw');
  for (const secret of ['Jane', 'jane@', '555-0199', 'Smith']) assert.ok(!err.message.includes(secret), 'message leaks ' + secret);
  assert.match(err.message, /no header row/);
});
test('rows that do not line up with the header, unclosed quotes and Excel damage are counted', () => {
  const t = 'First Name,Last Name,E-mail Address,Mobile Phone,Notes\r\nA,B,a@x.com,4.15556E+09,ok\r\nSmith, Jr,C,c@x.com,#NAME?,x\r\nD,E,d@x.com,1,"unclosed\r\nF,G,f@x.com,2,y\r\n';
  const m = E.parseContactFile(t, 'bad').mapping;
  assert.equal(m.raggedRows, 1);
  assert.equal(m.unterminatedQuote, true);
  assert.equal(m.excelDamage, 2);
});
test('a note containing BEGIN:VCARD does not turn a CSV into a vCard', () => {
  const t = 'First Name,Last Name,Notes\r\nA,B,"pasted:\r\nBEGIN:VCARD\r\nFN:X\r\nEND:VCARD"\r\nC,D,z\r\n';
  const r = E.parseContactFile(t, 'v');
  assert.equal(r.format, 'csv');
  assert.equal(r.contacts.length, 2);
});
test('truncation detector catches any shared cut-off length, e.g. 1024', () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ notes: String(i).padEnd(1024, 'x') }));
  assert.ok(E.suspectTruncatedNotes([...many, { notes: 'short' }, { notes: 'y'.repeat(700) }]) >= 40);
});

console.log('Other export formats');
const utf16 = s => { const b = Buffer.from('﻿' + s, 'utf16le'); return new Uint8Array(b); };
test('UTF-16 tab-delimited Outlook export (Excel "Unicode Text") with a multi-line note', () => {
  const txt = 'First Name\tLast Name\tE-mail Address\tMobile Phone\tNotes\r\nRenée\tO\'Brien\trenee@x.com\t415-555-0101\t"line one\r\nline two — ok"\r\n';
  const d = E.decodeContactFile(utf16(txt));
  assert.equal(d.encoding, 'utf-16le');
  const r = E.parseContactFile(d.text, 'u16');
  assert.equal(r.delimiter, '\t');
  const c = r.contacts[0];
  assert.equal(c.name, "Renée O'Brien");
  assert.equal(c.notes, 'line one\nline two — ok');
  assert.deepEqual(c.phones, ['415-555-0101']);
});
test('UTF-16 without a BOM is still detected', () => {
  const b = new Uint8Array(Buffer.from('First Name,Last Name,E-mail Address\r\nAl,Bee,al@x.com\r\n', 'utf16le'));
  assert.equal(E.decodeContactFile(b).encoding, 'utf-16le');
});
test('Google Contacts CSV: numbered Phone/E-mail/Address columns, ":::" multi-values, labels', () => {
  const g = 'First Name,Middle Name,Last Name,Nickname,Organization Name,Organization Title,Birthday,Notes,Labels,E-mail 1 - Label,E-mail 1 - Value,E-mail 2 - Label,E-mail 2 - Value,Phone 1 - Label,Phone 1 - Value,Phone 2 - Label,Phone 2 - Value,Address 1 - Label,Address 1 - Street,Address 1 - City,Address 1 - Region,Address 1 - Postal Code,Address 1 - Country\r\n' +
    'Jamie,,Fowler,Jay,Acme,CEO,1970-05-01,"note a\nnote b",* myContacts ::: Friends,* Home,jamie@x.com ::: jf@y.com,Work,jamie@acme.com,Mobile,(415) 555-0123 ::: (415) 555-0124,Work Fax,(415) 555-0199,Home,1 Main St,SF,CA,94110,USA\r\n';
  const r = E.parseContactFile(g, 'google');
  assert.equal(r.mapping.native, false);
  const c = r.contacts[0];
  assert.equal(c.name, 'Jamie Fowler');
  assert.equal(c.org, 'Acme');
  assert.equal(c.title, 'CEO');
  assert.deepEqual(c.emails.sort(), ['jamie@acme.com', 'jamie@x.com', 'jf@y.com']);
  assert.equal(c.phones.length, 3);
  assert.ok(c.props.some(p => p.name === 'TEL' && /FAX/.test(p.params)));
  assert.ok(c.addresses[0].includes('1 Main St'));
  assert.equal(c.notes, 'note a\nnote b');
  // exported to Outlook columns, not dumped into Notes
  const row = E.buildOutlookRow(c, E.OUTLOOK_DEFAULT_HEADER);
  const cell = n => row[E.OUTLOOK_DEFAULT_HEADER.indexOf(n)];
  assert.equal(cell('First Name'), 'Jamie');
  assert.equal(cell('Mobile Phone'), '(415) 555-0123');
  assert.equal(cell('Business Fax'), '(415) 555-0199');
  assert.equal(cell('Home Street'), '1 Main St');
  assert.ok(cell('Notes').startsWith('note a\r\nnote b'));
});
test('hand-made sheet "Name, Email, Phone, Notes" with a title line and Excel "sep=," hint', () => {
  const t = 'sep=,\r\nPhyllis contacts export\r\nName,Email,Cell,Comments,Favorite Color\r\n"Lee, Ann",ann@x.com,555-0100,"hi, there",blue\r\n';
  const r = E.parseContactFile(t, 'sheet');
  const c = r.contacts[0];
  assert.equal(c.name, 'Lee, Ann');
  assert.deepEqual(c.nField.slice(0, 2), ['Lee', 'Ann']);
  assert.deepEqual(c.emails, ['ann@x.com']);
  assert.deepEqual(c.phones, ['555-0100']);
  assert.equal(c.notes, 'hi, there');
  assert.ok(c.props.some(p => p.name.startsWith('X-OUTLOOK-FAVORITE-COLOR') && p.value === 'blue'), 'unknown column kept');
});
test('rows from a spreadsheet library (xlsx path) parse the same as CSV', () => {
  const r = E.parseContactRows([['First Name', 'Last Name', 'E-mail Address', 'Notes'], ['Bo', 'Diddley', 'bo@x.com', 'a\nb'], ['', '', '', '']], 'xl', ',');
  assert.equal(r.contacts.filter(c => !c.empty).length, 1);
  assert.equal(r.contacts[0].notes, 'a\nb');
});
test('file sniffing: .pst / .xlsx / zip / plain text', () => {
  assert.equal(E.sniffFileKind(new Uint8Array([0x21, 0x42, 0x44, 0x4E, 0]), 'x.bin'), 'pst');
  assert.equal(E.sniffFileKind(new Uint8Array([0x50, 0x4B, 3, 4]), 'Contacts.xlsx'), 'xlsx');
  assert.equal(E.sniffFileKind(new Uint8Array([0x50, 0x4B, 3, 4]), 'Contacts.olm'), 'olm');
  assert.equal(E.sniffFileKind(new Uint8Array([0x46, 0x69]), 'Contacts.CSV'), 'text');
});
test('a duplicate header name never loses the second column', () => {
  const r = E.parseContactFile('First Name,Last Name,Notes,Notes\r\nA,B,one,two\r\n', 'dup');
  const c = r.contacts[0];
  assert.equal(c.notes, 'one');
  assert.ok(c.props.some(p => p.value === 'two'), 'second Notes column kept as an extra field');
});
test('Outlook CSV + iPhone vCard two-file mode cross-matches the same person', () => {
  const v = E.parseVCards(card(['FN:Nellie Boykoff', 'N:Boykoff;Nellie;;;', 'TEL;type=CELL:+1 (415) 260-4307', 'NOTE:From the phone']), 'iPhone');
  live.forEach(c => (c.source = 'Outlook')); v.forEach(c => (c.source = 'iPhone'));
  const all = E.findDuplicateGroups([...live, ...v], 60);
  assert.equal(all.groups.length, 1);
  assert.equal(all.groups[0].contacts.length, 3);
  // "between files only": the two Outlook rows aren't compared to each other, but the phone card still finds its match.
  const cross = E.findDuplicateGroups([...live, ...v], 60, { crossOnly: true });
  assert.equal(cross.groups.length, 1);
  assert.ok(cross.groups[0].contacts.some(c => c.source === 'iPhone') && cross.groups[0].contacts.some(c => c.source === 'Outlook'));
});
test('a vCard-only contact exported to Outlook CSV keeps every phone/email/address (overflow goes to Notes)', () => {
  const c = E.parseVCards(card(['FN:Many Numbers', 'N:Numbers;Many;;;', ...['111','222','333','444'].map(x => 'EMAIL:e' + x + '@x.com'),
    'TEL;TYPE=WORK:415-555-1001', 'TEL;TYPE=WORK:415-555-1002', 'TEL;TYPE=WORK:415-555-1003', 'TEL;TYPE=WORK:415-555-1004', 'TEL;TYPE=WORK:415-555-1005',
    'ADR;TYPE=HOME:;;1 A St;SF;CA;94100;', 'ADR;TYPE=HOME:;;2 B St;SF;CA;94100;', 'BDAY:1960-07-04', 'NICKNAME:Manny', 'NOTE:orig note']))[0];
  const h = E.OUTLOOK_DEFAULT_HEADER;
  const row = E.buildOutlookRow(c, h);
  const all = row.join('\n');
  for (const x of ['e111@x.com','e222@x.com','e333@x.com','e444@x.com','415-555-1001','415-555-1005','1 A St','2 B St','Manny','orig note']) assert.ok(all.includes(x), 'missing ' + x);
  assert.equal(row[h.indexOf('Birthday')], '7/4/1960');
  assert.equal(row[h.indexOf('Last Name')], 'Numbers');
});
test('truncation detector flags a file where many notes are exactly 255 chars', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ notes: 'x'.repeat(255) }));
  assert.ok(E.suspectTruncatedNotes(many) > 0);
  assert.equal(E.suspectTruncatedNotes([{ notes: 'x'.repeat(255) }, { notes: 'y'.repeat(300) }]), 0);
});

// ── Optional: real export smoke test ─────────────────────────────
const realPath = process.argv[2];
if (realPath) {
  console.log('Real file: ' + realPath);
  const text = readFileSync(realPath, 'utf8');
  const contacts = E.parseVCards(text, 'real');
  const t0 = Date.now();
  const { groups, unique } = E.findDuplicateGroups(contacts, 60);
  const ms = Date.now() - t0;
  for (const g of groups) { g.merged = E.mergeContacts(g.contacts); g.status = 'approved'; }
  const note = E.checkNoteIntegrity(groups), field = E.checkFieldIntegrity(groups);
  const out = [...groups.map(g => g.merged), ...unique.filter(c => !c.empty)];
  const exportText = out.map(E.contactToVCard).join('');
  const second = E.findDuplicateGroups(E.parseVCards(exportText), 60);
  const totalNotesIn = contacts.reduce((s, c) => s + E.noteCharCount(c.notes), 0);
  const totalNotesOut = out.reduce((s, c) => s + E.noteCharCount(c.notes), 0);
  console.log(`  contacts ${contacts.length} (empty ${contacts.filter(c => c.empty).length}) · groups ${groups.length} · match ${ms} ms`);
  console.log(`  note integrity ${note.ok ? 'OK' : 'FAIL ' + note.failures.length} · field integrity ${field.ok ? 'OK' : 'FAIL ' + field.failures.length}`);
  console.log(`  note chars in ${totalNotesIn} → out ${totalNotesOut} (out ≥ in minus exact-duplicate notes)`);
  console.log(`  export ${out.length} cards, ${(exportText.length / 1e6).toFixed(1)} MB, CRLF-only ${!/[^\r]\n/.test(exportText)}, second pass 95%+ groups: ${second.groups.filter(g => g.confidence >= 95).length}`);
  test('real file: no note or field loss across every merge', () => { assert.ok(note.ok && field.ok); });
  test('real file: second pass finds no 95%+ groups', () => { assert.equal(second.groups.filter(g => g.confidence >= 95).length, 0); });

  // Same data as an Outlook CSV: export → re-import → dedupe → export again.
  const live0 = contacts.filter(c => !c.empty);
  const csv1 = E.writeOutlookCSV(live0, null, ',');
  const enc = E.encodeOutlookCSV(csv1, 'windows-1252');
  const re = E.parseContactFile(E.decodeContactFile(enc.bytes).text, 'outlook');
  const reLive = re.contacts.filter(c => !c.empty);
  const notesIn = live0.reduce((s, c) => s + E.noteCharCount(c.notes), 0);
  const notesRe = reLive.reduce((s, c) => s + E.noteCharCount(c.notes), 0);
  const t1 = Date.now();
  const r2 = E.findDuplicateGroups(re.contacts, 60);
  for (const g of r2.groups) { g.merged = E.mergeContacts(g.contacts); g.status = 'approved'; }
  const csvOut = E.writeOutlookCSV([...r2.groups.map(g => g.merged), ...r2.unique.filter(c => !c.empty)], re.header, ',');
  const csvRows = E.parseCSV(csvOut, ',');
  console.log(`  as Outlook CSV: ${(csv1.length / 1e6).toFixed(1)} MB, encoded ${enc.encoding}, re-imported ${reLive.length} contacts, ${r2.groups.length} groups in ${Date.now() - t1} ms`);
  console.log(`  note chars: vCard ${notesIn} → CSV ${notesRe} (CSV adds overflow fields to notes)`);
  test('real file via Outlook CSV: every contact survives the round trip', () => { assert.equal(reLive.length, live0.length); });
  test('real file via Outlook CSV: no note text lost converting to CSV', () => {
    let lost = 0; reLive.forEach((c, i) => { if (live0[i].notes && !c.notes.includes(live0[i].notes)) lost++; });
    assert.equal(lost, 0, lost + ' notes not found intact');
  });
  test('real file via Outlook CSV: merges pass note and field integrity', () => {
    assert.ok(E.checkNoteIntegrity(r2.groups).ok && E.checkFieldIntegrity(r2.groups).ok);
  });
  test('real file via Outlook CSV: every email and phone of every merge lands in the output CSV', () => {
    const outText = csvRows.map(r => r.join('\u0001')).join('\n').toLowerCase();
    const outDigits = outText.replace(/\D/g, '');
    let missing = 0;
    for (const g of r2.groups) for (const c of g.contacts) {
      for (const e of c.emails) if (!outText.includes(e.toLowerCase()) && !g.merged.emails.some(m => E.normalizeEmail(m) === E.normalizeEmail(e))) missing++;
      for (const p of c.phones) { const d = E.normalizePhone(p); if (d ? !outDigits.includes(d) : !outText.includes(p.toLowerCase())) missing++; }
    }
    assert.equal(missing, 0, missing + ' values missing');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
