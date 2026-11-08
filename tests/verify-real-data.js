#!/usr/bin/env node
/*
 * Real-data verification for DeDupe Pro.
 *
 * Runs the engine against the two REAL contact exports (READ-ONLY — the
 * source files are never written to) and asserts the full pipeline:
 *
 *   a. parse counts per file; empty junk cards (no name/email/phone/org)
 *      are counted and proven to stay out of every group and to pass
 *      through to the export untouched (never merged, never lost).
 *   b. P1 master-only run @ threshold 50: auto-approve ONLY autoMergeSafe
 *      groups, buildExport, assert noteIntegrityReport losses == [],
 *      print before/after note char totals, assert idempotency (re-parse
 *      the exported file, re-run detection, expect 0 autoMergeSafe).
 *   c. P2 combined run (master + iphone tagged by source): same integrity
 *      assertions; print the number of cross-file groups.
 *   d. count sanity: input - exported == exact merged-away member count.
 *   e. spot-check 3 merged contacts with multi-line notes: every member's
 *      full note text must be contained in the merged note.
 *   f. all artifacts are written to /tmp/dedupe-verify/ ONLY.
 *
 * Run:  node tests/verify-real-data.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const MASTER_PATH = '/Users/iamtheking/Documents/Contacts/ALLSynologyContactsSep292025.vcf';
const IPHONE_PATH = '/Users/iamtheking/Documents/Contacts/All iPhone Contacts.vcf';
const OUT_DIR = '/tmp/dedupe-verify';
const THRESHOLD = 50;

// ---------------------------------------------------------------------------
// reporting helpers — everything printed also lands in report.txt
// ---------------------------------------------------------------------------
const reportLines = [];
function say(s) {
  s = String(s == null ? '' : s);
  reportLines.push(s);
  console.log(s);
}
let failures = 0;
function assert(name, cond, detail) {
  if (cond) say('  PASS  ' + name);
  else {
    failures++;
    say('  FAIL  ' + name + (detail != null ? '  — ' + detail : ''));
  }
}
function hr(t) { say(''); say('=== ' + t + ' ' + '='.repeat(Math.max(4, 66 - t.length))); }
const ms = (t0) => (Date.now() - t0) + 'ms';

// ---------------------------------------------------------------------------
// domain helpers
// ---------------------------------------------------------------------------
function isEmptyCard(c) {
  return !(c.name && c.name.trim()) &&
    c.emails.length === 0 &&
    c.phones.length === 0 &&
    !(c.org && String(c.org).trim());
}
function noteCharTotal(contacts) {
  return contacts.reduce((t, c) => t + c.notes.reduce((s, n) => s + (n ? n.length : 0), 0), 0);
}
// mirror of the engine's note cleanup so containment checks compare like for like
function cleanNote(n) {
  return String(n).replace(/\r\n|\r/g, '\n').replace(/\s+$/, '');
}
function memberNoteContained(mergedNote, memberNote) {
  const t = cleanNote(memberNote);
  if (!t) return true;
  return mergedNote.indexOf(t) !== -1;
}
function approveSafeGroups(groups) {
  let n = 0;
  groups.forEach((g) => {
    if (g.autoMergeSafe === true && g.status === 'pending') {
      g.merged = E.mergeContacts(g.contacts); // UI contract field; === g.members
      g.status = 'approved';
      n++;
    }
  });
  return n;
}
function mergedAway(groups) {
  return groups.reduce((t, g) => t + (g.status === 'approved' ? Math.max(0, g.members.length - 1) : 0), 0);
}
function groupNames(g) {
  return g.members.map((m) => m.name || '(no name)').join(' / ');
}

// Structural sanity for an exported .vcf: balanced cards, CRLF folding
// within 75 octets, every logical (unfolded) line a well-formed prop.
// NOTE: a fold may legally split a line BEFORE its colon (RFC 6350 §3.2 —
// unfolding happens before parsing), so the colon check runs on unfolded
// logical lines, not physical ones.
function validateVcfStructure(text, label, expectedCards) {
  const lines = text.split('\r\n');
  let depth = 0, cards = 0, maxBytes = 0, maxLine = 0;
  const bad = [];
  const logical = [];
  lines.forEach((ln, i) => {
    const b = Buffer.byteLength(ln, 'utf8');
    if (b > maxBytes) { maxBytes = b; maxLine = i + 1; }
    if (ln === 'BEGIN:VCARD') { depth++; if (depth === 1) cards++; else bad.push('line ' + (i + 1) + ': nested BEGIN'); }
    else if (ln === 'END:VCARD') { depth--; if (depth < 0) bad.push('line ' + (i + 1) + ': END without BEGIN'); }
    else if (ln === '') { if (i !== lines.length - 1) bad.push('line ' + (i + 1) + ': stray empty line'); }
    // unfold
    if (/^[ \t]/.test(ln) && logical.length) logical[logical.length - 1] += ln.slice(1);
    else if (ln !== '') logical.push(ln);
  });
  logical.forEach((ln) => {
    if (ln.indexOf(':') === -1) bad.push('logical line without colon: ' + ln.slice(0, 60));
  });
  if (depth !== 0) bad.push('unbalanced BEGIN/END depth ' + depth);
  say('  [' + label + '] cards=' + cards + '  physicalLines=' + lines.length +
    '  longestLine=' + maxBytes + 'B (line ' + maxLine + ')  structuralIssues=' + bad.length);
  bad.slice(0, 10).forEach((b) => say('    ! ' + b));
  assert(label + ': BEGIN/END balanced, one card per pair', cards === expectedCards && depth === 0,
    'cards=' + cards + ' expected=' + expectedCards + ' depth=' + depth);
  assert(label + ': all physical lines fold within 75 octets', maxBytes <= 75,
    'longest=' + maxBytes + 'B at line ' + maxLine);
  assert(label + ': no malformed/loose lines', bad.length === 0, bad.slice(0, 3).join(' | '));
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
function main() {
  if (typeof E.parseVCards !== 'function' || typeof E.findDuplicateGroups !== 'function') {
    throw new Error('engine failed to load via require("../engine.js")');
  }
  say('DeDupe Pro — REAL DATA verification   engine v' + E.VERSION + '   ' + new Date().toISOString());
  say('threshold=' + THRESHOLD + '   outputs -> ' + OUT_DIR + ' (sources are read-only)');

  // ── (a) parse both files ────────────────────────────────────────────────
  hr('(a) PARSE');
  let t0 = Date.now();
  const masterText = fs.readFileSync(MASTER_PATH, 'utf8');
  const master = E.parseVCards(masterText, 'master');
  say('master  : ' + path.basename(MASTER_PATH) + '  (' + (masterText.length / 1048576).toFixed(1) +
    ' MB) -> ' + master.length + ' cards   [' + ms(t0) + ']');

  t0 = Date.now();
  const iphoneText = fs.readFileSync(IPHONE_PATH, 'utf8');
  const iphone = E.parseVCards(iphoneText, 'iphone');
  say('iphone  : ' + path.basename(IPHONE_PATH) + '  (' + (iphoneText.length / 1048576).toFixed(1) +
    ' MB) -> ' + iphone.length + ' cards   [' + ms(t0) + ']');

  const masterEmpty = master.filter(isEmptyCard);
  const iphoneEmpty = iphone.filter(isEmptyCard);
  say('empty junk cards (no name/email/phone/org): master=' + masterEmpty.length +
    '  iphone=' + iphoneEmpty.length);

  // empty cards must be inert: run detection over ONLY empty cards
  t0 = Date.now();
  const emptyOnly = E.findDuplicateGroups(iphoneEmpty, { threshold: THRESHOLD });
  say('  findDuplicateGroups over ' + iphoneEmpty.length + ' empty cards: groups=' +
    emptyOnly.groups.length + ' unique=' + emptyOnly.unique.length + '   [' + ms(t0) + ']');
  assert('empty cards produce zero groups', emptyOnly.groups.length === 0);
  assert('every empty card lands in unique (pass-through)', emptyOnly.unique.length === iphoneEmpty.length);
  // and they cannot crash anything downstream
  let crashed = null;
  try {
    E.contactToVCard(iphoneEmpty[0] || { props: [], name: '', emails: [], phones: [], notes: [] });
    E.generateCSV(iphoneEmpty);
    E.generateJSON(iphoneEmpty.slice(0, 5));
    E.noteIntegrityReport(iphoneEmpty, iphoneEmpty);
    if (E.mergeContacts([]) !== null) throw new Error('mergeContacts([]) should be null');
  } catch (e) { crashed = e; }
  assert('empty cards survive serialize/report calls without crashing', crashed === null,
    crashed && crashed.message);

  // ── (b) P1: master only ─────────────────────────────────────────────────
  hr('(b) P1 — MASTER ONLY @ threshold ' + THRESHOLD);
  t0 = Date.now();
  const res1 = E.findDuplicateGroups(master, { threshold: THRESHOLD });
  const find1 = ms(t0);
  const safe1 = res1.groups.filter((g) => g.autoMergeSafe).length;
  say('groups=' + res1.groups.length + '  autoMergeSafe=' + safe1 +
    '  reviewOnly=' + (res1.groups.length - safe1) + '  unique=' + res1.unique.length +
    '   [find ' + find1 + ']');
  say('empty cards inside any P1 group: ' +
    res1.groups.reduce((n, g) => n + g.members.filter(isEmptyCard).length, 0));
  assert('P1: no empty card appears in any group',
    res1.groups.every((g) => g.members.every((m) => !isEmptyCard(m))));

  t0 = Date.now();
  const approved1 = approveSafeGroups(res1.groups);
  const out1 = E.buildExport(res1.groups, res1.unique);
  say('approved(merged)=' + approved1 + '  exported contacts=' + out1.contacts.length +
    '   [merge+export ' + ms(t0) + ']');

  t0 = Date.now();
  const int1 = E.noteIntegrityReport(master, out1.contacts);
  say('note integrity P1: before ' + int1.before.chars.toLocaleString() + ' chars / ' +
    int1.before.lines.toLocaleString() + ' lines / ' + int1.before.withNotes + ' contacts-with-notes' +
    '  ->  after ' + int1.after.chars.toLocaleString() + ' chars / ' +
    int1.after.lines.toLocaleString() + ' lines / ' + int1.after.withNotes +
    '   [integrity ' + ms(t0) + ']');
  if (int1.losses.length) say('  LOSSES: ' + int1.losses.slice(0, 20).join('; '));
  assert('P1: noteIntegrityReport losses is EMPTY', int1.losses.length === 0,
    int1.losses.length + ' losses');

  // (d) count sanity P1
  const away1 = mergedAway(res1.groups);
  say('count sanity P1: input=' + master.length + '  exported=' + out1.contacts.length +
    '  groupsMerged=' + approved1 + '  membersMergedAway=' + away1 +
    '  drop=' + (master.length - out1.contacts.length));
  assert('P1: drop == members merged away exactly',
    master.length - out1.contacts.length === away1,
    (master.length - out1.contacts.length) + ' vs ' + away1);
  // every empty master card must be in the export, untouched (same object ref)
  const out1Set = new Set(out1.contacts);
  assert('P1: every empty card present in export, unmodified',
    masterEmpty.every((c) => out1Set.has(c) && c._source === 'master'));

  // idempotency
  t0 = Date.now();
  const re1 = E.parseVCards(out1.vcfText, 'reimport');
  const res1b = E.findDuplicateGroups(re1, { threshold: THRESHOLD });
  const residSafe = res1b.groups.filter((g) => g.autoMergeSafe);
  say('idempotency: re-parsed export -> ' + re1.length + ' contacts; re-run find -> ' +
    res1b.groups.length + ' residual groups (' + residSafe.length + ' autoMergeSafe)   [' + ms(t0) + ']');
  assert('idempotency: re-parse count == exported count', re1.length === out1.contacts.length,
    re1.length + ' vs ' + out1.contacts.length);
  if (res1b.groups.length) {
    say('  residual groups for human review (expected: previously review-only, still unmerged):');
    res1b.groups.slice(0, 25).forEach((g) =>
      say('    - ' + groupNames(g) + '  [conf=' + g.confidence +
        (g.autoMergeSafe ? ', AUTO-SAFE' : '') + (g.warnings.length ? ', warnings: ' + g.warnings.join('; ') : '') + ']'));
    if (res1b.groups.length > 25) say('    … and ' + (res1b.groups.length - 25) + ' more');
  }
  assert('idempotency: 0 autoMergeSafe groups on merged output', residSafe.length === 0,
    residSafe.map(groupNames).slice(0, 10).join(' | '));

  validateVcfStructure(out1.vcfText, 'P1 merged-master.vcf', out1.contacts.length);

  // ── (c) P2: combined ────────────────────────────────────────────────────
  hr('(c) P2 — COMBINED master + iphone @ threshold ' + THRESHOLD);
  const combined = master.concat(iphone);
  say('combined input=' + combined.length + '  (master ' + master.length + ' + iphone ' + iphone.length + ')');
  t0 = Date.now();
  const res2 = E.findDuplicateGroups(combined, { threshold: THRESHOLD });
  const find2 = ms(t0);
  const safe2 = res2.groups.filter((g) => g.autoMergeSafe).length;
  const crossFile = res2.groups.filter((g) => new Set(g.members.map((m) => m._source)).size > 1);
  say('groups=' + res2.groups.length + '  autoMergeSafe=' + safe2 +
    '  reviewOnly=' + (res2.groups.length - safe2) + '  unique=' + res2.unique.length +
    '   [find ' + find2 + ']');
  say('cross-file groups (span both sources): ' + crossFile.length);
  crossFile.slice(0, 15).forEach((g) =>
    say('    - ' + groupNames(g) + '  [conf=' + g.confidence + (g.autoMergeSafe ? ', AUTO-SAFE' : '') + ']'));
  assert('P2: no empty card appears in any group',
    res2.groups.every((g) => g.members.every((m) => !isEmptyCard(m))));

  t0 = Date.now();
  const approved2 = approveSafeGroups(res2.groups);
  const out2 = E.buildExport(res2.groups, res2.unique);
  say('approved(merged)=' + approved2 + '  exported contacts=' + out2.contacts.length +
    '   [merge+export ' + ms(t0) + ']');

  t0 = Date.now();
  const int2 = E.noteIntegrityReport(combined, out2.contacts);
  say('note integrity P2: before ' + int2.before.chars.toLocaleString() + ' chars / ' +
    int2.before.lines.toLocaleString() + ' lines / ' + int2.before.withNotes + ' contacts-with-notes' +
    '  ->  after ' + int2.after.chars.toLocaleString() + ' chars / ' +
    int2.after.lines.toLocaleString() + ' lines / ' + int2.after.withNotes +
    '   [integrity ' + ms(t0) + ']');
  if (int2.losses.length) say('  LOSSES: ' + int2.losses.slice(0, 20).join('; '));
  assert('P2: noteIntegrityReport losses is EMPTY', int2.losses.length === 0,
    int2.losses.length + ' losses');

  const away2 = mergedAway(res2.groups);
  say('count sanity P2: input=' + combined.length + '  exported=' + out2.contacts.length +
    '  groupsMerged=' + approved2 + '  membersMergedAway=' + away2 +
    '  drop=' + (combined.length - out2.contacts.length));
  assert('P2: drop == members merged away exactly',
    combined.length - out2.contacts.length === away2,
    (combined.length - out2.contacts.length) + ' vs ' + away2);
  const out2Set = new Set(out2.contacts);
  assert('P2: every empty card (both files) present in export, unmodified',
    masterEmpty.concat(iphoneEmpty).every((c) => out2Set.has(c)));

  // photos: every exported PHOTO payload must be byte-identical to a source payload
  const srcPhotos = new Set();
  combined.forEach((c) => c.props.forEach((p) => { if (p.name === 'PHOTO') srcPhotos.add(String(p.value)); }));
  let photoCount = 0, photoBad = 0;
  out2.contacts.forEach((c) => c.props.forEach((p) => {
    if (p.name !== 'PHOTO') return;
    photoCount++;
    if (!srcPhotos.has(String(p.value))) photoBad++;
  }));
  say('photos: source payloads=' + srcPhotos.size + '  exported photo props=' + photoCount +
    '  not-found-in-source=' + photoBad);
  assert('P2: every exported PHOTO is byte-identical to a source PHOTO', photoBad === 0,
    photoBad + ' corrupted');

  validateVcfStructure(out2.vcfText, 'P2 merged-combined.vcf', out2.contacts.length);

  // ── (e) spot-check multi-line note merges ───────────────────────────────
  hr('(e) SPOT-CHECK — merged contacts with multi-line notes');
  const approvedGroups = res2.groups.filter((g) => g.status === 'approved');
  const withMultiline = approvedGroups.filter((g) =>
    g.members.some((m) => m.notes.some((n) => n && n.indexOf('\n') !== -1)));
  say('approved groups where a member has a multi-line note: ' + withMultiline.length);
  // prefer cross-file groups for the sample
  const sample = withMultiline
    .slice()
    .sort((a, b) => {
      const ax = new Set(a.members.map((m) => m._source)).size;
      const bx = new Set(b.members.map((m) => m._source)).size;
      return bx - ax || b.memberCount - a.memberCount;
    })
    .slice(0, 3);
  sample.forEach((g, i) => {
    const mergedNote = g.merged.notes.join(E.NOTE_SEPARATOR);
    say('  sample ' + (i + 1) + ': group ' + g.id + '  conf=' + g.confidence +
      '  merged name="' + g.merged.name + '"');
    let allIn = true;
    g.members.forEach((m) => {
      const mChars = m.notes.reduce((s, n) => s + (n ? n.length : 0), 0);
      const contained = m.notes.every((n) => memberNoteContained(mergedNote, n));
      if (!contained) allIn = false;
      say('    member [' + (m._source || '?') + ' #' + m._sourceIdx + '] "' + (m.name || '(no name)') +
        '"  noteProps=' + m.notes.length + '  noteChars=' + mChars +
        '  fullyContainedInMerged=' + contained);
    });
    say('    merged noteChars=' + mergedNote.length + '  lines=' + mergedNote.split('\n').length);
    assert('spot-check ' + (i + 1) + ': every member note fully contained in merged note', allIn);
  });
  if (sample.length === 0) say('  (no multi-line-note merges found — nothing to spot-check)');

  // ── (f) write artifacts + eyeball samples ───────────────────────────────
  hr('(f) ARTIFACTS -> ' + OUT_DIR);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const statsFor = (input, groups, out, approvedN, extra) => Object.assign({
    'Threshold': THRESHOLD,
    'Total contacts before': input,
    'Total contacts after': out.contacts.length,
    'Duplicate groups': groups.length,
    'Groups approved/merged': approvedN,
    'Groups left pending (review-only, exported unmerged)': groups.length - approvedN,
  }, extra || {});
  const audit1 = E.generateAuditLog(res1.groups, statsFor(master.length, res1.groups, out1, approved1));
  const audit2 = E.generateAuditLog(res2.groups, statsFor(combined.length, res2.groups, out2, approved2, {
    'Cross-file groups': crossFile.length,
  }));
  fs.writeFileSync(path.join(OUT_DIR, 'merged-master.vcf'), out1.vcfText);
  fs.writeFileSync(path.join(OUT_DIR, 'merged-combined.vcf'), out2.vcfText);
  fs.writeFileSync(path.join(OUT_DIR, 'audit-master.txt'), audit1);
  fs.writeFileSync(path.join(OUT_DIR, 'audit-combined.txt'), audit2);
  say('wrote merged-master.vcf (' + (out1.vcfText.length / 1048576).toFixed(1) + ' MB), ' +
    'merged-combined.vcf (' + (out2.vcfText.length / 1048576).toFixed(1) + ' MB), audit-master.txt, audit-combined.txt');

  // eyeball: one long-note merged card and one photo card from the combined export
  const longNoteCard = approvedGroups
    .map((g) => g.merged)
    .sort((a, b) => noteCharTotal([b]) - noteCharTotal([a]))[0];
  if (longNoteCard) {
    say('  eyeball — merged card with the longest note ("' + longNoteCard.name + '"):');
    E.contactToVCard(longNoteCard).split('\r\n').slice(0, 14).forEach((l) =>
      say('    | ' + (l.length > 110 ? l.slice(0, 110) + '…' : l)));
    say('    | … (note continues, ' + noteCharTotal([longNoteCard]) + ' note chars total)');
  }
  const photoCard = out2.contacts.find((c) => c.props.some((p) => p.name === 'PHOTO'));
  if (photoCard) {
    say('  eyeball — a card carrying PHOTO ("' + (photoCard.name || '(no name)') + '"):');
    E.contactToVCard(photoCard).split('\r\n').slice(0, 10).forEach((l) =>
      say('    | ' + (l.length > 110 ? l.slice(0, 110) + '…' : l)));
  }

  // ── verdict ─────────────────────────────────────────────────────────────
  hr('VERDICT');
  say(failures === 0 ? 'ALL ASSERTIONS PASSED' : failures + ' ASSERTION(S) FAILED');
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), reportLines.join('\n') + '\n');
  process.exitCode = failures === 0 ? 0 : 1;
}

try {
  main();
} catch (e) {
  say('VERIFY CRASH: ' + (e && e.stack || e));
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), reportLines.join('\n') + '\n');
  } catch (_) { /* ignore */ }
  process.exitCode = 2;
}
