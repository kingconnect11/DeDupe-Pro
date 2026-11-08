#!/usr/bin/env node
/*
 * Zero-dependency test suite for engine.js (DedupeEngine).
 * Run with:  node tests/run-tests.js
 *
 * NOTE on module loading: a stray package.json with "type":"module" exists in
 * a parent directory of this repo (~ package.json), so Node treats every .js
 * file here as ESM and `require()` is unavailable in this file. To stay
 * robust under BOTH module systems this runner uses only dynamic import() and
 * loads engine.js by evaluating its source with a module shim — the exact
 * same code the browser gets, loaded through the UMD's CJS branch.
 */
(async function main() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const assert = (await import('node:assert')).default;

  const TESTS_DIR = path.dirname(path.resolve(process.argv[1]));
  const ROOT = path.join(TESTS_DIR, '..');
  const fx = (n) => fs.readFileSync(path.join(TESTS_DIR, 'fixtures', n), 'utf8');

  const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
  const shim = { exports: {} };
  new Function('module', 'exports', 'self', engineSrc)(shim, shim.exports, {});
  const E = shim.exports;
  assert.ok(E && typeof E.parseVCards === 'function', 'engine failed to load');

  let pass = 0, fail = 0;
  const failures = [];
  function test(name, fn) {
    try {
      fn();
      pass++;
      console.log('ok   - ' + name);
    } catch (e) {
      fail++;
      failures.push(name);
      console.log('FAIL - ' + name + '\n       ' + String((e && e.message) || e).split('\n').join('\n       '));
    }
  }
  const vcf = (props) =>
    'BEGIN:VCARD\r\nVERSION:3.0\r\n' + props.join('\r\n') + '\r\nEND:VCARD\r\n';
  const contactWith = (props, source) => E.parseVCards(vcf(props), source)[0];
  const noteContact = (note, name) =>
    contactWith(['FN:' + (name || 'X'), 'NOTE:' + E.escapeText(note)]);

  // ---------------------------------------------------------------------------
  console.log('--- parsing & note round-trip ---');

  test('1. multi-line NOTE with \\n escapes parses to real newlines and round-trips', () => {
    const cs = E.parseVCards(fx('multiline-note.vcf'));
    assert.strictEqual(cs.length, 1);
    const expected = 'Line one\nLine two\nLine three with, comma and; semicolon and \\ backslash\nLine four';
    assert.strictEqual(cs[0].notes.length, 1);
    assert.strictEqual(cs[0].notes[0], expected);
    const out = E.contactToVCard(cs[0]);
    assert.ok(out.indexOf('\r\n') !== -1, 'CRLF line endings');
    const re = E.parseVCards(out);
    assert.strictEqual(re[0].notes[0], expected, 'note content not byte-identical after round trip');
  });

  test('5. quoted-printable NOTE (vCard 2.1, CHARSET, soft breaks) decodes', () => {
    const cs = E.parseVCards(fx('quoted-printable.vcf'));
    assert.strictEqual(cs.length, 1);
    const c = cs[0];
    assert.strictEqual(c.name, 'Jürgen Müller', 'QP FN with CHARSET=UTF-8');
    assert.strictEqual(c.notes.length, 1);
    const note = c.notes[0];
    assert.ok(note.indexOf('Café notes line 1') === 0, 'ISO-8859-1 =E9 -> é');
    assert.ok(note.indexOf('split here') !== -1, 'soft break joined');
    assert.strictEqual(note, 'Café notes line 1\r\nline 2 with soft break split here\r\nline 3 done');
  });

  test('6a. vCard 2.1 sample parses (bare TYPE params, QP, CHARSET)', () => {
    const c = E.parseVCards(fx('quoted-printable.vcf'))[0];
    assert.strictEqual(c.phones.length, 1);
    assert.strictEqual(c.phones[0].value, '+1 (555) 123-4567');
    const types = [].concat(c.phones[0].params.TYPE || []);
    assert.ok(types.indexOf('HOME') !== -1 && types.indexOf('VOICE') !== -1, 'bare 2.1 params -> TYPE');
    const n = c.props.find((p) => p.name === 'N');
    assert.deepStrictEqual(n.value, ['Müller', 'Jürgen', '', '', '']);
  });

  test('6b. vCard 4.0 sample parses (structured N, quoted TYPE, KIND, ANNIVERSARY)', () => {
    const c = E.parseVCards(fx('vcard40.vcf'))[0];
    assert.strictEqual(c.name, 'Dr. Jane Q. Public');
    assert.strictEqual(c.emails[0].value, 'jane@work.example');
    assert.strictEqual(E.normalizePhone(c.phones[0].value), '15559876543');
    const types = [].concat(c.phones[0].params.TYPE || []);
    assert.ok(types.indexOf('cell') !== -1 && types.indexOf('voice') !== -1, 'quoted comma TYPE list');
    assert.strictEqual(c.org, 'Example Corp Research Division');
    assert.strictEqual(c.birthday, '19750412');
    assert.strictEqual(c.isGroup, false);
    assert.ok(c.props.some((p) => p.name === 'ANNIVERSARY' && p.value === '20010615'), 'unknown 4.0 prop kept');
  });

  test('9a. escaping torture: commas, semicolons, backslashes, multi-line round-trip', () => {
    const c = E.parseVCards(fx('escapes.vcf'))[0];
    assert.strictEqual(c.name, 'Doe, John "Johnny" \\ Esq.');
    const org = c.props.find((p) => p.name === 'ORG');
    assert.deepStrictEqual(org.value, ['Acme, Inc.', 'R;D Dept; West']);
    assert.strictEqual(c.title, 'Senior VP, R&D');
    assert.strictEqual(c.notes[0], 'Multi\\backslash\ncomma, semicolon; colon: newline\nnext line 100% done');
    const adr = c.props.find((p) => p.name === 'ADR');
    assert.strictEqual(adr.value[2], '123 Main St, Apt; 4');
    const re = E.parseVCards(E.contactToVCard(c))[0];
    assert.strictEqual(re.name, c.name);
    assert.deepStrictEqual(re.props.find((p) => p.name === 'ORG').value, org.value);
    assert.strictEqual(re.notes[0], c.notes[0]);
    assert.strictEqual(re.props.find((p) => p.name === 'ADR').value[2], adr.value[2]);
    assert.strictEqual(re.title, c.title);
  });

  test('9b. folding: >75-octet lines fold with CRLF+space and unfold losslessly (UTF-8 safe)', () => {
    const longLine = 'x'.repeat(120) + ' — ' + 'ü'.repeat(60) + ' end';
    const c = noteContact('intro\n' + longLine + '\noutro', 'Folder');
    const out = E.contactToVCard(c);
    out.split('\r\n').forEach((phys) => {
      assert.ok(Buffer.byteLength(phys, 'utf8') <= 75, 'physical line exceeds 75 octets: ' + phys.slice(0, 40));
    });
    const re = E.parseVCards(out)[0];
    assert.strictEqual(re.notes[0], c.notes[0], 'fold/unfold changed the note');
  });

  // ---------------------------------------------------------------------------
  console.log('--- merging: note preservation ---');

  test('2. merge of two multi-line notes keeps BOTH complete texts, every line', () => {
    const cs = E.parseVCards(fx('duplicates.vcf'), 'import');
    cs[0]._source = 'master';
    const merged = E.mergeContacts(cs);
    assert.strictEqual(merged.notes.length, 1, 'merged into a single note');
    const note = merged.notes[0];
    const noteA = ['First note from A.', 'It has several lines.', 'Keep every one.'];
    const noteB = ['Second note from B.', 'Completely different content.', 'Also multi-line.'];
    noteA.concat(noteB).forEach((line) => {
      assert.ok(note.indexOf(line) !== -1, 'missing line: ' + line);
    });
    assert.ok(note.indexOf(noteA[0]) < note.indexOf(noteB[0]), 'master note should come first');
    assert.ok(note.indexOf(E.NOTE_SEPARATOR.trim()) !== -1, 'separator present');
  });

  test('3. contained note dedupes to the longer one; identical notes dedupe to one', () => {
    const a = noteContact('Short note');
    const b = noteContact('Short note\n\nLonger part');
    const m1 = E.mergeContacts([a, b]);
    assert.strictEqual(m1.notes[0], 'Short note\n\nLonger part');
    const c1 = noteContact('Same\nnote');
    const c2 = noteContact('Same\nnote');
    const m2 = E.mergeContacts([c1, c2]);
    assert.strictEqual(m2.notes[0], 'Same\nnote');
    assert.strictEqual(m2.notes.length, 1);
  });

  test('4. multiple NOTE properties on one contact all survive a merge', () => {
    const multi = E.parseVCards(
      vcf(['FN:Multi Note', 'NOTE:first note', 'NOTE:second note\\nwith line two'])
    )[0];
    assert.strictEqual(multi.notes.length, 2);
    const other = noteContact('third note');
    const merged = E.mergeContacts([multi, other]);
    const note = merged.notes[0];
    assert.ok(note.indexOf('first note') !== -1);
    assert.ok(note.indexOf('second note\nwith line two') !== -1);
    assert.ok(note.indexOf('third note') !== -1);
  });

  // ---------------------------------------------------------------------------
  console.log('--- merging: field superset ---');

  test('7a. field superset: emails/phones/addresses/URLs/nicknames/X- props all survive', () => {
    const cs = E.parseVCards(fx('duplicates.vcf'), 'import');
    cs[0]._source = 'master';
    const merged = E.mergeContacts(cs);
    const emails = merged.emails.map((e) => e.value).sort();
    assert.deepStrictEqual(emails, ['bill@home.example', 'bill@work.example', 'william@other.example']);
    const work = merged.emails.find((e) => e.value === 'bill@work.example');
    assert.ok([].concat(work.params.TYPE || []).indexOf('PREF') !== -1, 'richer TYPE params win');
    assert.strictEqual(merged.phones.length, 1, 'same phone digits dedupe to one');
    assert.strictEqual(merged.urls.length, 2);
    assert.strictEqual(merged.addresses.length, 1);
    assert.strictEqual(merged.addresses[0].value[2], '42 Lane');
    assert.strictEqual(merged.nickname, 'Bill');
    assert.strictEqual(merged.birthday, '19620304');
    assert.ok(merged.props.some((p) => p.name === 'X-CUSTOM-A' && p.value === 'alpha-value'), 'X-CUSTOM-A kept');
    assert.ok(merged.props.some((p) => p.name === 'X-CUSTOM-B' && p.value === 'beta-value'), 'X-CUSTOM-B kept');
  });

  test('7b. iCloud itemN.-prefixed props parse and export cleanly; group cards intact', () => {
    const cs = E.parseVCards(fx('icloud.vcf'), 'icloud');
    assert.strictEqual(cs.length, 2);
    const irene = cs[0], group = cs[1];
    assert.strictEqual(irene.emails[0].value, 'irene@icloud.example', 'item1. prefix stripped for recognition');
    assert.strictEqual(irene.emails[0].params.TYPE, 'INTERNET');
    assert.strictEqual(irene.urls[0].value, 'https://irene.example');
    const labels = irene.props.filter((p) => p.name === 'X-ABLABEL');
    assert.strictEqual(labels.length, 2, 'X-ABLABEL props preserved');
    assert.ok(labels.every((p) => p.group === 'item1' || p.group === 'item2'), 'group prefix info preserved');
    assert.ok(irene.props.some((p) => p.name === 'X-ABUID'), 'X-ABUID preserved');
    const photo = irene.props.find((p) => p.name === 'PHOTO');
    assert.ok(photo && String(photo.value).indexOf('/9j/') === 0, 'base64 PHOTO kept raw');
    assert.strictEqual(group.isGroup, true, 'KIND:group detected');

    const out = E.contactToVCard(irene);
    assert.ok(out.indexOf('item1.') === -1, 'export is valid without itemN. prefixes');
    assert.ok(out.indexOf('EMAIL;TYPE=INTERNET:irene@icloud.example') !== -1);
    assert.ok(out.indexOf('PHOTO;ENCODING=b;TYPE=JPEG:') !== -1, 'PHOTO re-emitted with ENCODING=b');
    assert.ok(out.indexOf('X-ABUID:AB1234-CDEF:ABPerson') !== -1);
    const re = E.parseVCards(out)[0];
    assert.strictEqual(re.emails[0].value, 'irene@icloud.example');
    const rePhoto = re.props.find((p) => p.name === 'PHOTO');
    assert.strictEqual(String(rePhoto.value), String(photo.value), 'PHOTO survived round trip');

    // group cards are never deduped
    const dupeGroupCard = E.parseVCards(fx('icloud.vcf'), 'icloud2')[1];
    const res = E.findDuplicateGroups([group, dupeGroupCard, irene]);
    assert.strictEqual(res.groups.length, 0);
    assert.ok(res.unique.indexOf(group) !== -1 && res.unique.indexOf(dupeGroupCard) !== -1,
      'group cards always in unique');
  });

  test('8. singleton conflict: master wins, loser preserved in labeled note appendix', () => {
    const cs = E.parseVCards(fx('duplicates.vcf'), 'import');
    cs[0]._source = 'master';
    const merged = E.mergeContacts(cs);
    assert.strictEqual(merged.name, 'Bill Thompson', 'master FN wins');
    assert.strictEqual(merged.org, 'Thompson Consulting', 'master ORG wins');
    assert.strictEqual(merged.title, 'Owner', 'master TITLE wins');
    const note = merged.notes[0];
    assert.ok(note.indexOf('[Merged from duplicate]') !== -1, 'appendix header present');
    assert.ok(note.indexOf('Organization: Different Org Inc') !== -1, 'losing ORG preserved');
    assert.ok(note.indexOf('Title: Consultant') !== -1, 'losing TITLE preserved');
    assert.ok(note.indexOf('Name: William Thompson') !== -1, 'losing FN preserved');
  });

  // ---------------------------------------------------------------------------
  console.log('--- matching ---');

  test('normalize* helpers', () => {
    assert.strictEqual(E.normalizeName('  José   García! '), 'jose garcia');
    assert.strictEqual(E.normalizeEmail('  Foo@BAR.com '), 'foo@bar.com');
    assert.strictEqual(E.normalizePhone('+1 (555) 123-4567'), '15551234567');
    assert.strictEqual(E.soundex('Robert'), 'R163');
    assert.strictEqual(E.soundex('Rupert'), 'R163');
  });

  test('nickname-equivalent names match as review-only group', () => {
    const a = contactWith(['FN:Bill Smith', 'N:Smith;Bill;;;']);
    const b = contactWith(['FN:William Smith', 'N:Smith;William;;;']);
    const res = E.findDuplicateGroups([a, b]);
    assert.strictEqual(res.groups.length, 1);
    const g = res.groups[0];
    assert.ok(g.factors.indexOf('Nickname name match') !== -1);
    assert.ok(g.warnings.indexOf('Name-only match') !== -1);
    assert.strictEqual(g.autoMergeSafe, false, 'name-only match must be review-only');
    assert.strictEqual(res.unique.length, 0);
  });

  test('autoMergeSafe only for >=90 email/phone-backed matches without warnings', () => {
    const a = contactWith(['FN:Sam Oak', 'EMAIL:sam@oak.example']);
    const b = contactWith(['FN:Sam Oak', 'EMAIL:sam@oak.example']);
    const g = E.findDuplicateGroups([a, b]).groups[0];
    assert.strictEqual(g.confidence, 100);
    assert.strictEqual(g.autoMergeSafe, true);

    // same evidence but conflicting orgs -> warning -> not safe
    const c = contactWith(['FN:Sam Oak', 'EMAIL:sam@oak.example', 'ORG:Oak Corp']);
    const d = contactWith(['FN:Sam Oak', 'EMAIL:sam@oak.example', 'ORG:Other LLC']);
    const g2 = E.findDuplicateGroups([c, d]).groups[0];
    assert.ok(g2.warnings.indexOf('Different organizations') !== -1);
    assert.strictEqual(g2.autoMergeSafe, false);
  });

  test('phone-only match found at default threshold; threshold option respected', () => {
    const a = contactWith(['FN:Alpha One', 'TEL:+1-555-777-8888']);
    const b = contactWith(['FN:Beta Two', 'TEL:(555) 777-8888']);
    assert.strictEqual(E.findDuplicateGroups([a, b]).groups.length, 1, 'last-7 phone match');
    assert.strictEqual(E.findDuplicateGroups([a, b], { threshold: 45 }).groups.length, 0);
  });

  test('buckets with >50 members skip pair generation', () => {
    const many = [];
    for (let i = 0; i < 60; i++) {
      many.push(contactWith(['FN:Same Person', 'EMAIL:person' + i + '@example.com']));
    }
    const res = E.findDuplicateGroups(many);
    assert.strictEqual(res.groups.length, 0);
    assert.strictEqual(res.unique.length, 60);
  });

  // ---------------------------------------------------------------------------
  console.log('--- idempotency ---');

  test('10. find+merge on merged output finds zero groups and changes nothing', () => {
    const text = fx('duplicates.vcf') + fx('multiline-note.vcf') + fx('escapes.vcf');
    const cs = E.parseVCards(text, 'master');
    const res1 = E.findDuplicateGroups(cs);
    assert.strictEqual(res1.groups.length, 1, 'exactly the Thompson pair groups');
    res1.groups.forEach((g) => { g.status = 'approved'; });
    const out1 = E.buildExport(res1.groups, res1.unique);
    assert.strictEqual(out1.contacts.length, 3, '2 merged into 1, 2 uniques untouched');

    // second pass over the exported file
    const cs2 = E.parseVCards(out1.vcfText);
    const res2 = E.findDuplicateGroups(cs2);
    assert.strictEqual(res2.groups.length, 0, 'no groups found on merged output');
    const out2 = E.buildExport(res2.groups, res2.unique);
    assert.strictEqual(out2.vcfText, out1.vcfText, 'export not stable across a full round trip');

    // mergeContacts is itself idempotent
    const merged = out1.contacts[0];
    assert.strictEqual(E.mergeContacts([merged]), merged, 'single contact returned unchanged');
    const remerged = E.mergeContacts(res1.groups[0].members);
    assert.strictEqual(remerged.notes[0], merged.notes[0], 're-merge of same members is stable');
  });

  // ---------------------------------------------------------------------------
  console.log('--- reports & exports ---');

  test('generateCSV / generateJSON produce usable output', () => {
    const cs = E.parseVCards(fx('duplicates.vcf') + fx('multiline-note.vcf'), 'master');
    cs[0]._source = 'master';
    const res = E.findDuplicateGroups(cs);
    res.groups.forEach((g) => { g.status = 'approved'; });
    const out = E.buildExport(res.groups, res.unique);

    const csv = E.generateCSV(out.contacts);
    assert.ok(csv.indexOf('Name,Nickname,Organization') === 0, 'CSV header');
    assert.ok(csv.indexOf('"') !== -1, 'multi-line note cell is quoted');
    assert.ok(csv.indexOf('First note from A.') !== -1);

    const json = E.generateJSON(out.contacts);
    const parsed = JSON.parse(json);
    assert.strictEqual(parsed.length, out.contacts.length);
    assert.ok(parsed[0].notes[0].indexOf('First note from A.') !== -1, 'notes survive JSON');
  });

  test('generateAuditLog: members, confidence, factors, warnings, note chars', () => {
    const cs = E.parseVCards(fx('duplicates.vcf'), 'master');
    const res = E.findDuplicateGroups(cs);
    res.groups.forEach((g) => { g.status = 'approved'; });
    const out = E.buildExport(res.groups, res.unique);
    const log = E.generateAuditLog(res.groups, {
      'Total contacts before': cs.length,
      'Total contacts after': out.contacts.length
    });
    assert.ok(log.indexOf('MERGE PLAN') !== -1);
    assert.ok(log.indexOf('GROUP 1') !== -1);
    assert.ok(log.indexOf('confidence=100') !== -1);
    assert.ok(log.indexOf('Bill Thompson') !== -1 && log.indexOf('William Thompson') !== -1);
    assert.ok(log.indexOf('source=master') !== -1);
    assert.ok(log.indexOf('Factors:') !== -1 && log.indexOf('Shared email address') !== -1);
    assert.ok(log.indexOf('Warnings:') !== -1 && log.indexOf('Different organizations') !== -1);
    const m = log.match(/Resulting note: (\d+) chars/);
    assert.ok(m && Number(m[1]) > 100, 'resulting note char count reported');
    assert.ok(log.indexOf('Total contacts after: 1') !== -1);
  });

  test('noteIntegrityReport: detects losses, clean after a good merge', () => {
    const before = E.parseVCards(fx('duplicates.vcf'), 'master');
    const res = E.findDuplicateGroups(before);
    res.groups.forEach((g) => { g.status = 'approved'; });
    const good = E.buildExport(res.groups, res.unique);
    const clean = E.noteIntegrityReport(before, good.contacts);
    assert.deepStrictEqual(clean.losses, []);
    assert.strictEqual(clean.before.contacts, 2);
    assert.strictEqual(clean.after.contacts, 1);
    assert.strictEqual(clean.before.withNotes, 2);

    // simulate the old tool's defect: one truncated note, the other gone entirely
    const damaged = E.parseVCards(vcf([
      'FN:Bill Thompson',
      'EMAIL;TYPE=HOME:bill@home.example',
      'NOTE:First note from A.'
    ]));
    const bad = E.noteIntegrityReport(before, damaged);
    assert.deepStrictEqual(bad.losses, ['Bill Thompson', 'William Thompson'],
      'both shrunk and vanished notes must be flagged');

    // pending groups pass through untouched: report must show zero losses
    const res2 = E.findDuplicateGroups(before);
    const passthrough = E.buildExport(res2.groups, res2.unique); // all pending
    assert.strictEqual(passthrough.contacts.length, 2);
    assert.deepStrictEqual(E.noteIntegrityReport(before, passthrough.contacts).losses, [],
      'unmerged pass-through must not be flagged as loss');
  });

  // ---------------------------------------------------------------------------
  console.log('--- scale test ---');

  test('11. scale: ~9000 contacts / ~1500 planted dupes, zero note loss, correct count', () => {
    function mulberry32(a) {
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rnd = mulberry32(42);
    const WORDS = ['apple', 'bridge', 'cable', 'delta', 'ember', 'forest', 'garden', 'harbor',
      'island', 'jungle', 'kite', 'lemon', 'meadow', 'north', 'ocean', 'piano'];
    const FIRST = ['Aaron', 'Abigail', 'Adrian', 'Agnes', 'Alan', 'Albert', 'Alexa', 'Alfred',
      'Alice', 'Alvin', 'Amanda', 'Amber', 'Amy', 'Andre', 'Angela', 'Anita', 'Anna', 'Arnold',
      'Arthur', 'Audrey', 'Barbara', 'Barry', 'Beatrice', 'Benjamin', 'Bernard', 'Bertha', 'Beverly',
      'Brandon', 'Brenda', 'Brian', 'Bruce', 'Bryan', 'Caleb', 'Carl', 'Carla', 'Carmen', 'Cecil',
      'Celia', 'Chad', 'Charlene', 'Chester', 'Chloe', 'Clara', 'Clarence', 'Clifford', 'Colleen',
      'Craig', 'Cynthia', 'Dale', 'Dana', 'Danielle', 'Darlene', 'Dean', 'Delores', 'Dennis', 'Derek',
      'Diana', 'Dolores', 'Dominic', 'Donna', 'Doris', 'Douglas', 'Duane', 'Dwight', 'Earl', 'Edgar',
      'Edith', 'Edmund', 'Edna', 'Eileen', 'Elaine', 'Eleanor', 'Elena', 'Elias', 'Ella', 'Ellen',
      'Elmer', 'Eloise', 'Elsie', 'Emanuel', 'Emma', 'Enid', 'Eric', 'Erica', 'Ernest', 'Esther',
      'Ethel', 'Eugene', 'Eunice', 'Evan', 'Evelyn', 'Everett', 'Felix', 'Fern', 'Flora', 'Floyd',
      'Frances', 'Franklin', 'Freda', 'Gail', 'Garrett', 'Geneva', 'Geoffrey', 'Gerald', 'Gilbert',
      'Gladys', 'Glen', 'Gloria', 'Gordon', 'Grant', 'Greta', 'Harold', 'Harriet', 'Hazel', 'Hector',
      'Helen', 'Herbert', 'Herman', 'Hilda', 'Homer', 'Hope', 'Horace', 'Howard', 'Hubert', 'Ida',
      'Irene', 'Iris', 'Irma', 'Ivan', 'Jacob', 'Janet', 'Janice', 'Jean', 'Jerome', 'Jill', 'Joan',
      'Joyce', 'Judith', 'Julia', 'June', 'Karl', 'Keith', 'Kent', 'Kurt', 'Lamar', 'Laura', 'Leah',
      'Leon', 'Lester', 'Lillian', 'Lois', 'Loren', 'Lucille', 'Luther', 'Mabel', 'Marcia', 'Marian',
      'Marlene', 'Marsha', 'Martin', 'Marvin', 'Maureen', 'Maxine', 'Melvin', 'Mildred', 'Miriam',
      'Monica', 'Muriel', 'Myra', 'Myrtle', 'Nadine', 'Naomi', 'Neil', 'Nina', 'Nora', 'Norman',
      'Olga', 'Olive', 'Oliver', 'Omar', 'Oscar', 'Paula', 'Pauline', 'Pearl', 'Phyllis', 'Preston',
      'Ralph', 'Ramona', 'Regina', 'Renee', 'Rita', 'Roland', 'Rosa', 'Roy', 'Ruby', 'Ruth', 'Sheila',
      'Sidney', 'Sylvia', 'Teresa', 'Vera', 'Vernon', 'Wanda', 'Wilbur', 'Yolanda'];
    const NICK_PAIRS = [['William', 'Bill'], ['Robert', 'Bob'], ['Richard', 'Dick'], ['Michael', 'Mike'],
      ['Elizabeth', 'Liz'], ['Margaret', 'Maggie'], ['James', 'Jim'], ['John', 'Jack'],
      ['Charles', 'Chuck'], ['Joseph', 'Joe'], ['Thomas', 'Tom'], ['David', 'Dave'],
      ['Jennifer', 'Jen'], ['Katherine', 'Kate'], ['Susan', 'Sue'], ['Deborah', 'Debbie'],
      ['Nicholas', 'Nick'], ['Christopher', 'Chris'], ['Anthony', 'Tony'], ['Rebecca', 'Becky']];

    const N_UNIQUE = 7500, N_DUP = 1500;
    const pad7 = (n) => String(n).padStart(7, '0');
    function noteLines(id, minLines, maxLines) {
      const n = minLines + Math.floor(rnd() * (maxLines - minLines + 1));
      const lines = [];
      for (let k = 1; k <= n; k++) {
        const w = [];
        for (let j = 0; j < 6; j++) w.push(WORDS[Math.floor(rnd() * WORDS.length)]);
        lines.push('n' + id + ' line ' + k + ': ' + w.join(' '));
      }
      return lines.join('\n');
    }
    function makeVcf(c) {
      const props = ['FN:' + c.fn, 'N:' + c.last + ';' + c.first + ';;;'];
      if (c.email) props.push('EMAIL;TYPE=' + (c.emailType || 'HOME') + ':' + c.email);
      if (c.phone) props.push('TEL;TYPE=' + (c.phoneType || 'CELL') + ':' + c.phone);
      props.push('ORG:' + c.org);
      props.push('NOTE:' + E.escapeText(c.note));
      return vcf(props);
    }

    const t0 = Date.now();
    let text = '';
    for (let i = 0; i < N_UNIQUE; i++) {
      const planted = i < N_DUP && i % 4 === 2;
      const first = planted ? NICK_PAIRS[(i / 4 | 0) % NICK_PAIRS.length][0] : FIRST[i % FIRST.length];
      text += makeVcf({
        fn: first + ' Zqx' + i, first: first, last: 'Zqx' + i,
        email: 'user' + i + '@example.com',
        phone: '+1-555-' + pad7(i),
        org: 'Org' + i,
        note: noteLines('u' + i, i % 10 === 0 ? 50 : 3, i % 10 === 0 ? 60 : 8)
      });
    }
    for (let i = 0; i < N_DUP; i++) {
      const type = i % 4;
      const big = type === 3;
      const base = {
        last: 'Zqx' + i + 'alt', org: 'Org' + i,
        note: noteLines('d' + i, big ? 55 : 4, big ? 65 : 9),
        email: 'dup' + i + '@example.com',
        phone: '+1-555-' + pad7(5000000 + i)
      };
      if (type === 0) { // same email, different name
        base.first = FIRST[(i + 50) % FIRST.length];
        base.fn = base.first + ' Zqx' + i + 'alt';
        base.email = 'user' + i + '@example.com';
        base.emailType = 'WORK';
      } else if (type === 1) { // same phone, different everything else
        base.first = FIRST[(i + 75) % FIRST.length];
        base.fn = base.first + ' Zqx' + i;
        base.last = 'Zqx' + i;
        base.phone = '(555) ' + pad7(i).slice(0, 3) + '-' + pad7(i).slice(3);
      } else if (type === 2) { // nickname variant, same last name
        base.first = NICK_PAIRS[(i / 4 | 0) % NICK_PAIRS.length][1];
        base.fn = base.first + ' Zqx' + i;
        base.last = 'Zqx' + i;
      } else { // same email, different name, 50+ line note
        base.first = FIRST[(i + 100) % FIRST.length];
        base.fn = base.first + ' Zqx' + i + 'alt';
        base.email = 'user' + i + '@example.com';
        base.emailType = 'OTHER';
      }
      text += makeVcf(base);
    }
    const genMs = Date.now() - t0;

    const t1 = Date.now();
    const contacts = E.parseVCards(text, 'master');
    assert.strictEqual(contacts.length, N_UNIQUE + N_DUP);
    const res = E.findDuplicateGroups(contacts);
    const findMs = Date.now() - t1;
    assert.ok(findMs < 10000, 'findDuplicateGroups too slow: ' + findMs + 'ms');
    assert.strictEqual(res.groups.length, N_DUP, 'every planted dupe found, no false groups');
    assert.strictEqual(res.unique.length, N_UNIQUE - N_DUP);
    assert.ok(res.groups.every((g) => g.memberCount === 2), 'pairs only, no chaining');

    const t2 = Date.now();
    res.groups.forEach((g) => { g.status = 'approved'; });
    const out = E.buildExport(res.groups, res.unique);
    assert.strictEqual(out.contacts.length, N_UNIQUE, 'final count = uniques after merging dupes');
    const mergeMs = Date.now() - t2;

    const t3 = Date.now();
    const report = E.noteIntegrityReport(contacts, out.contacts);
    const checkMs = Date.now() - t3;
    assert.deepStrictEqual(report.losses, [], 'note losses: ' + report.losses.slice(0, 5).join('; '));
    assert.strictEqual(report.before.withNotes, N_UNIQUE + N_DUP);
    assert.strictEqual(report.after.withNotes, N_UNIQUE);
    assert.ok(report.after.chars >= report.before.chars, 'merged notes hold all content');

    // spot check: a 50+ line planted note survives in full
    const bigDupe = contacts[N_UNIQUE + 3]; // i=3 -> type 3 (big note)
    const bigMerged = out.contacts.find((c) => c.emails.some((e) => e.value === 'user3@example.com'));
    assert.ok(bigMerged, 'merged contact for user3 found');
    const expectedLines = bigDupe.notes[0].split('\n');
    expectedLines.forEach((line) => {
      assert.ok(bigMerged.notes[0].indexOf(line) !== -1, 'missing big-note line: ' + line.slice(0, 40));
    });
    assert.ok(bigMerged.notes[0].split('\n').length >= 60, '50+ line note kept all lines');

    console.log('       [scale] gen=' + genMs + 'ms parse+find=' + findMs +
      'ms merge+export=' + mergeMs + 'ms integrity=' + checkMs + 'ms');
    console.log('       [scale] before=' + report.before.chars + ' note chars, after=' +
      report.after.chars + ' note chars, lines ' + report.before.lines + ' -> ' + report.after.lines);
  });

  // ---------------------------------------------------------------------------
  console.log('');
  console.log(pass + ' passed, ' + fail + ' failed');
  if (failures.length) console.log('Failing tests:\n  - ' + failures.join('\n  - '));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('RUNNER CRASH:', e);
  process.exit(2);
});
