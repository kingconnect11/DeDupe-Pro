/*!
 * DedupeEngine — core engine for the DeDupe Pro contact deduplication tool.
 *
 * Zero-dependency, no DOM. Runs in the browser (window.DedupeEngine) and in
 * Node (module.exports).
 *
 * Design guarantees:
 *  - NOTE content is never lost or truncated: multi-line notes parse to real
 *    newlines, merge unions every note (dropping only exact duplicates or
 *    notes fully contained in a longer sibling), and export re-escapes
 *    newlines so the .vcf round-trips byte-identically in note content.
 *  - No field is silently dropped: props[] keeps every parsed property in
 *    original order (incl. unknown X-* props) so anything we do not
 *    explicitly merge still round-trips; unmapped CSV import columns are
 *    kept as X-CSV-* props for the same reason.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DedupeEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ENGINE_VERSION = '1.0.0';
  var NOTE_SEPARATOR = '\n\n----\n\n';
  var APPENDIX_HEADER = '[Merged from duplicate]';
  var BUCKET_LIMIT = 50;        // buckets larger than this skip pair generation
  var DEFAULT_THRESHOLD = 40;   // min pair score to become an edge

  // ---------------------------------------------------------------------------
  // Low-level text utilities
  // ---------------------------------------------------------------------------

  function utf8Len(ch) {
    var c = ch.codePointAt(0);
    return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }

  // Fold a logical line to <=75 octets per physical line (CRLF + single space).
  // Never splits inside a multi-byte UTF-8 character.
  function foldLine(line, limit) {
    limit = limit || 75;
    if (line === '') return '';
    var out = [], cur = '', curBytes = 0, first = true;
    for (var ch of line) {
      var b = utf8Len(ch);
      var cap = first ? limit : limit - 1; // continuation lines pay for the leading space
      if (curBytes + b > cap && cur !== '') {
        out.push((first ? '' : ' ') + cur);
        cur = ch; curBytes = b; first = false;
      } else {
        cur += ch; curBytes += b;
      }
    }
    out.push((first ? '' : ' ') + cur);
    return out.join('\r\n');
  }

  // vCard TEXT escaping: backslash, newline, comma, semicolon.
  function escapeText(s) {
    return String(s)
      .replace(/\\/g, '\\\\')
      .replace(/\r\n|\r|\n/g, '\\n')
      .replace(/,/g, '\\,')
      .replace(/;/g, '\\;');
  }

  function unescapeText(s) {
    var out = '', i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        var n = s[i + 1];
        if (n === 'n' || n === 'N') { out += '\n'; i += 2; continue; }
        if (n === '\\' || n === ',' || n === ';') { out += n; i += 2; continue; }
        out += n; i += 2; continue; // unknown escape: keep the char, drop the backslash
      }
      out += c; i++;
    }
    return out;
  }

  // Split on a separator that is not backslash-escaped.
  function splitUnescaped(s, sep) {
    var parts = [], cur = '', i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i += 2; continue; }
      if (c === sep) { parts.push(cur); cur = ''; i++; continue; }
      cur += c; i++;
    }
    parts.push(cur);
    return parts;
  }

  // Build logical lines from raw file text:
  //  - vCard folding: CRLF/LF followed by space or tab continues the line.
  //  - Quoted-printable soft breaks: a line whose header declares
  //    ENCODING=QUOTED-PRINTABLE and that ends in '=' continues on the next
  //    physical line; the trailing '=' and the break are removed (RFC 2045).
  function logicalLines(text) {
    var raw = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/); // strips leading BOM
    var lines = [], cur = null, i, phys;
    function headerOf(l) {
      var idx = l.indexOf(':');
      return idx === -1 ? l : l.slice(0, idx);
    }
    for (i = 0; i < raw.length; i++) {
      phys = raw[i];
      if (cur === null) { cur = phys; continue; }
      if (/^[ \t]/.test(phys)) { cur += phys.slice(1); continue; }
      if (/=$/.test(cur) && /ENCODING\s*=\s*QUOTED-PRINTABLE/i.test(headerOf(cur))) {
        cur = cur.slice(0, -1) + phys; continue;
      }
      lines.push(cur); cur = phys;
    }
    if (cur !== null) lines.push(cur);
    return lines;
  }

  function mapCharset(cs) {
    if (!cs) return 'utf-8';
    var u = String(cs).toUpperCase().replace(/["']/g, '').trim();
    if (u === 'UTF-8' || u === 'UTF8') return 'utf-8';
    if (u === 'ISO-8859-1' || u === 'LATIN1' || u === 'LATIN-1' || u === 'ISO8859-1') return 'iso-8859-1';
    if (u === 'WINDOWS-1252' || u === 'CP1252') return 'windows-1252';
    if (u === 'US-ASCII' || u === 'ASCII') return 'ascii';
    if (u === 'UTF-16' || u === 'UTF16' || u === 'UTF-16LE') return 'utf-16le';
    return 'utf-8';
  }

  // Decode a quoted-printable value, honoring CHARSET (vCard 2.1 / Outlook).
  function qpDecode(s, charset) {
    s = s.replace(/=\r\n|=\n|=\r/g, ''); // any surviving soft breaks
    var bytes = [], i, code;
    for (i = 0; i < s.length; i++) {
      var c = s[i];
      if (c === '=' && i + 2 < s.length && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) {
        bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; continue;
      }
      if (c === '=' && i === s.length - 1) continue; // dangling soft break
      code = s.codePointAt(i);
      if (code > 0xFFFF) i++;
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 63));
      else if (code < 0x10000) bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      else bytes.push(0xF0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    }
    var label = mapCharset(charset);
    try { return new TextDecoder(label).decode(new Uint8Array(bytes)); }
    catch (e) { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); }
  }

  // ---------------------------------------------------------------------------
  // vCard parsing
  // ---------------------------------------------------------------------------

  // Structured values split on unescaped ';' into component arrays.
  var STRUCTURED = { N: 1, ADR: 1, ORG: 1, GEO: 1 };
  // Comma-list values split on unescaped ',' into item arrays.
  var COMMALIST = { NICKNAME: 1, CATEGORIES: 1 };

  function addParam(params, k, v) {
    if (params[k] === undefined) params[k] = v;
    else if (Array.isArray(params[k])) params[k].push(v);
    else params[k] = [params[k], v];
  }
  function paramStr(v) { return Array.isArray(v) ? v.join(',') : (v || ''); }

  function parsePropLine(rawLine) {
    // Split header:value at the first ':' outside double quotes.
    var inQ = false, colon = -1, i, c;
    for (i = 0; i < rawLine.length; i++) {
      c = rawLine[i];
      if (c === '"') inQ = !inQ;
      else if (c === ':' && !inQ) { colon = i; break; }
    }
    var header = colon === -1 ? rawLine : rawLine.slice(0, colon);
    var rawValue = colon === -1 ? '' : rawLine.slice(colon + 1);

    // Split header on ';' outside quotes.
    var tokens = [], curT = '';
    inQ = false;
    for (i = 0; i < header.length; i++) {
      c = header[i];
      if (c === '"') inQ = !inQ;
      if (c === ';' && !inQ) { tokens.push(curT); curT = ''; continue; }
      curT += c;
    }
    tokens.push(curT);

    var nameToken = tokens.shift() || '';
    var group = null, name = nameToken;
    var dot = nameToken.lastIndexOf('.');
    if (dot !== -1) { group = nameToken.slice(0, dot); name = nameToken.slice(dot + 1); }
    name = name.toUpperCase();

    var params = {};
    for (i = 0; i < tokens.length; i++) {
      var t = tokens[i];
      if (!t) continue;
      var eq = t.indexOf('=');
      if (eq === -1) {
        // vCard 2.1 bare param: TYPE-ish keyword; BASE64 means base64 encoding.
        var bv = t.replace(/^"|"$/g, '');
        if (/^BASE64$/i.test(bv)) { params.ENCODING = 'b'; continue; }
        addParam(params, 'TYPE', bv.toUpperCase());
        continue;
      }
      var k = t.slice(0, eq).toUpperCase();
      var v = t.slice(eq + 1).replace(/^"|"$/g, '');
      if (k === 'TYPE') {
        var vals = v.split(',');
        for (var vi = 0; vi < vals.length; vi++) addParam(params, 'TYPE', vals[vi]);
      } else {
        addParam(params, k, v);
      }
    }

    var enc = paramStr(params.ENCODING).toUpperCase();
    var value;
    if (enc === 'B' || enc === 'BASE64') {
      value = rawValue.replace(/[ \t]/g, ''); // base64: keep raw, never mangle
    } else {
      var decoded = (enc === 'QUOTED-PRINTABLE') ? qpDecode(rawValue, paramStr(params.CHARSET)) : rawValue;
      var un = (enc === 'QUOTED-PRINTABLE') ? function (x) { return x; } : unescapeText;
      if (STRUCTURED[name]) {
        var comps = splitUnescaped(decoded, ';');
        value = comps.map(un);
      } else if (COMMALIST[name]) {
        var items = splitUnescaped(decoded, ',');
        value = items.map(un);
      } else {
        value = un(decoded);
      }
    }

    var prop = { name: name, params: params, value: value, rawLine: rawLine };
    if (group) prop.group = group; // e.g. iCloud itemN. prefix, preserved for info
    return prop;
  }

  function emptyContact(props) {
    return {
      props: props || [],
      name: '', emails: [], phones: [], notes: [], org: '', title: '',
      birthday: '', urls: [], addresses: [], nickname: '', isGroup: false,
      _source: undefined, _sourceIdx: -1, _idx: -1
    };
  }

  function orgString(v) {
    var comps = Array.isArray(v) ? v : [v];
    return comps.filter(function (x) { return String(x).trim(); }).join(' ');
  }

  // Recompute all convenience fields from props[].
  function deriveFields(c) {
    c.name = ''; c.emails = []; c.phones = []; c.notes = []; c.org = '';
    c.title = ''; c.birthday = ''; c.urls = []; c.addresses = [];
    c.nickname = ''; c.isGroup = false;
    var nComps = null;
    for (var i = 0; i < c.props.length; i++) {
      var p = c.props[i];
      switch (p.name) {
        case 'FN': if (!c.name && p.value) c.name = String(p.value); break;
        case 'N': if (!nComps) nComps = p.value; break;
        case 'EMAIL': c.emails.push({ value: String(p.value), params: p.params }); break;
        case 'TEL': c.phones.push({ value: String(p.value), params: p.params }); break;
        case 'NOTE': c.notes.push(String(p.value)); break;
        case 'ORG': if (!c.org) c.org = orgString(p.value); break;
        case 'TITLE': if (!c.title) c.title = String(p.value); break;
        case 'BDAY': if (!c.birthday) c.birthday = String(p.value); break;
        case 'URL': c.urls.push({ value: String(p.value), params: p.params }); break;
        case 'ADR': c.addresses.push({ value: p.value, params: p.params }); break;
        case 'NICKNAME':
          if (!c.nickname) c.nickname = Array.isArray(p.value) ? p.value.join(', ') : String(p.value);
          break;
        case 'KIND': if (String(p.value).toLowerCase() === 'group') c.isGroup = true; break;
        case 'X-ADDRESSBOOKSERVER-KIND': if (String(p.value).toLowerCase() === 'group') c.isGroup = true; break;
      }
    }
    if (!c.name && nComps) {
      var nm = [nComps[3], nComps[1], nComps[2], nComps[0], nComps[4]]
        .filter(function (x) { return x && String(x).trim(); }).join(' ');
      c.name = nm;
    }
    return c;
  }

  // Parse one or more .vcf files' text into contact objects.
  // source: optional tag stored on _source (e.g. 'master', 'icloud').
  function parseVCards(text, source) {
    var lines = logicalLines(text);
    var contacts = [], cur = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || !line.trim()) continue;
      var u = line.toUpperCase();
      if (u === 'BEGIN:VCARD') { cur = emptyContact([]); continue; }
      if (u === 'END:VCARD') { if (cur) { contacts.push(deriveFields(cur)); cur = null; } continue; }
      if (!cur) continue; // junk outside cards
      cur.props.push(parsePropLine(line));
    }
    if (cur) contacts.push(deriveFields(cur)); // tolerate unterminated card
    for (i = 0; i < contacts.length; i++) {
      contacts[i]._source = source || 'import';
      contacts[i]._sourceIdx = i;
      contacts[i]._idx = i;
    }
    return contacts;
  }

  // ---------------------------------------------------------------------------
  // Normalization helpers (exposed for tests)
  // ---------------------------------------------------------------------------

  function normalizeName(s) {
    if (!s) return '';
    return String(s).toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '') // combining diacritical marks
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  function normalizeEmail(s) { return String(s || '').trim().toLowerCase(); }
  function normalizePhone(s) { return String(s || '').replace(/\D/g, ''); }
  function phoneKey(s) {
    var d = normalizePhone(s);
    return d.length >= 7 ? d.slice(-7) : '';
  }

  var NAME_SUFFIXES = {
    jr: 1, sr: 1, ii: 1, iii: 1, iv: 1, v: 1,
    md: 1, dds: 1, phd: 1, esq: 1, mba: 1, cpa: 1, rn: 1, do: 1, jd: 1, dvm: 1
  };
  function stripNameSuffixes(norm) {
    var parts = norm.split(' ').filter(Boolean);
    while (parts.length > 2 && NAME_SUFFIXES[parts[parts.length - 1]]) parts.pop();
    return parts.join(' ');
  }

  // American Soundex.
  function soundex(s) {
    s = String(s || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (!s) return '';
    var codes = {
      B: 1, F: 1, P: 1, V: 1, C: 2, G: 2, J: 2, K: 2, Q: 2, S: 2, X: 2, Z: 2,
      D: 3, T: 3, L: 4, M: 5, N: 5, R: 6
    };
    var out = s[0], prev = codes[s[0]] || 0;
    for (var i = 1; i < s.length; i++) {
      var c = codes[s[i]] || 0;
      if (c && c !== prev) out += c;
      if (s[i] !== 'H' && s[i] !== 'W') prev = c; // H/W do not break code runs
      if (out.length >= 4) break;
    }
    return (out + '000').slice(0, 4);
  }

  // Built-in nickname equivalences: canonical name first, variants after.
  var NICKNAME_GROUPS = [
    ['william', 'bill', 'billy', 'will', 'willie', 'liam', 'willy', 'billie', 'willis', 'wills'],
    ['robert', 'bob', 'bobby', 'rob', 'robbie', 'bert', 'robby', 'bobbie', 'robby'],
    ['richard', 'dick', 'rick', 'ricky', 'rich', 'richie', 'rickey', 'ritchie'],
    ['michael', 'mike', 'mikey', 'mick', 'mickey', 'micky', 'misha'],
    ['elizabeth', 'liz', 'lizzy', 'lizzie', 'beth', 'betsy', 'betty', 'eliza', 'libby', 'liza', 'bess', 'bessie'],
    ['margaret', 'maggie', 'meg', 'peggy', 'peg', 'marge', 'margie', 'midge', 'gretta', 'rita', 'margo'],
    ['james', 'jim', 'jimmy', 'jamie', 'jem', 'jimmie'],
    ['john', 'jack', 'johnny', 'jon', 'jackie', 'johnnie', 'ian'],
    ['charles', 'charlie', 'chuck', 'chas', 'chaz', 'chuckie', 'charley'],
    ['joseph', 'joe', 'joey'],
    ['thomas', 'tom', 'tommy', 'thom', 'tomas'],
    ['david', 'dave', 'davey', 'davy'],
    ['daniel', 'dan', 'danny', 'dani'],
    ['edward', 'ed', 'eddie', 'ted', 'teddy', 'ned', 'edd'],
    ['anthony', 'tony', 'ant'],
    ['andrew', 'andy', 'drew'],
    ['christopher', 'chris', 'topher', 'kit', 'christy', 'kris'],
    ['matthew', 'matt', 'matty', 'mattie', 'mat'],
    ['nicholas', 'nick', 'nicky'],
    ['joshua', 'josh'],
    ['jacob', 'jake'],
    ['jonathan', 'jonny', 'jonathon'],
    ['nathaniel', 'nate', 'nathan', 'nat'],
    ['samuel', 'sam', 'sammy'],
    ['benjamin', 'ben', 'benny', 'benji'],
    ['steven', 'steve', 'stevie', 'stephen', 'steph', 'stefan'],
    ['gregory', 'greg', 'gregg'],
    ['jeffrey', 'jeff', 'geoff'],
    ['timothy', 'tim', 'timmy'],
    ['kenneth', 'ken', 'kenny'],
    ['raymond', 'ray'],
    ['donald', 'don', 'donnie'],
    ['ronald', 'ron', 'ronnie'],
    ['frederick', 'fred', 'freddie', 'freddy', 'fritz'],
    ['frank', 'frankie', 'francis', 'franko'],
    ['albert', 'al', 'bertie'],
    ['arthur', 'art', 'artie'],
    ['bernard', 'bernie', 'barney'],
    ['clarence', 'clare'],
    ['clifford', 'cliff'],
    ['curtis', 'curt'],
    ['dennis', 'denny'],
    ['douglas', 'doug'],
    ['ernest', 'ernie'],
    ['eugene', 'gene'],
    ['gerald', 'jerry', 'gerry'],
    ['gilbert', 'gil'],
    ['harold', 'harry', 'hal'],
    ['henry', 'hank'],
    ['howard', 'howie'],
    ['irving', 'irv'],
    ['lawrence', 'larry', 'laurence', 'lars'],
    ['leonard', 'leo', 'lenny', 'len'],
    ['lucas', 'luke'],
    ['marcus', 'mark', 'markus'],
    ['martin', 'marty'],
    ['melvin', 'mel'],
    ['mortimer', 'mort'],
    ['norman', 'norm'],
    ['oliver', 'ollie'],
    ['patrick', 'paddy', 'pat'],
    ['peter', 'pete'],
    ['philip', 'phil', 'phillip', 'pip'],
    ['randall', 'randy'],
    ['reginald', 'reggie'],
    ['rodney', 'rod'],
    ['russell', 'rusty', 'russ'],
    ['scott', 'scotty'],
    ['sidney', 'sid'],
    ['stanley', 'stan'],
    ['theodore', 'theo', 'tad'],
    ['terrence', 'terry', 'terence'],
    ['tobias', 'toby'],
    ['victor', 'vic'],
    ['vincent', 'vince', 'vinny'],
    ['walter', 'walt', 'wally'],
    ['zachary', 'zack', 'zach', 'zak'],
    ['abigail', 'abby', 'gail'],
    ['alexandra', 'alex', 'lexi', 'sandra2'],
    ['amanda', 'mandy', 'amy'],
    ['amelia', 'millie'],
    ['angela', 'angie'],
    ['ann', 'annie', 'anna', 'annabel'],
    ['antonia', 'toni'],
    ['beatrice', 'bea', 'trixie'],
    ['katherine', 'kate', 'kathy', 'katie', 'kat', 'kitty', 'cathy', 'catherine', 'kathryn', 'kathleen'],
    ['charlotte', 'lottie'],
    ['christina', 'tina', 'chrissy'],
    ['cynthia', 'cindy'],
    ['dolores', 'lola', 'lolly'],
    ['dorothy', 'dot', 'dottie', 'dotty'],
    ['edith', 'edie'],
    ['eleanor', 'ellie', 'nora', 'ella', 'nell2'],
    ['emily', 'em', 'emmy'],
    ['evelyn', 'evie'],
    ['florence', 'flo', 'flossie'],
    ['frances', 'fran', 'frannie', 'franny'],
    ['gabrielle', 'gabby'],
    ['georgia', 'georgie'],
    ['grace', 'gracie'],
    ['helen', 'lena', 'nell'],
    ['isabel', 'isabella', 'bella', 'izzy', 'ibby'],
    ['jacqueline', 'jacqui'],
    ['janet', 'jan'],
    ['jean', 'jeanie', 'jeanette'],
    ['jennifer', 'jen', 'jenny'],
    ['jessica', 'jess', 'jessie'],
    ['jillian', 'jill'],
    ['joan', 'joanna', 'joanie'],
    ['judith', 'judy'],
    ['julia', 'julie', 'jules'],
    ['kimberly', 'kim', 'kimmy'],
    ['laura', 'laurie'],
    ['leslie', 'les'],
    ['lillian', 'lily', 'lil'],
    ['lucille', 'lucy'],
    ['madeline', 'maddie', 'maddy'],
    ['marcia', 'marcie'],
    ['martha', 'marti'],
    ['maureen', 'mo'],
    ['maxine', 'max'],
    ['melanie', 'lani'],
    ['michelle', 'shelly', 'shell'],
    ['mildred', 'milly'],
    ['natalie', 'nat2'],
    ['nicole', 'nikki'],
    ['olivia', 'liv', 'livvy'],
    ['pamela', 'pam'],
    ['patricia', 'patty', 'tricia', 'trish', 'patsy'],
    ['pauline', 'polly'],
    ['penelope', 'penny'],
    ['priscilla', 'cilla'],
    ['rachel', 'rae'],
    ['rebecca', 'becca', 'becky'],
    ['rose', 'rosie', 'rosemary', 'rosalie'],
    ['ruth', 'ruthie'],
    ['samantha', 'sammie'],
    ['sandra', 'sandy'],
    ['sarah', 'sally', 'sadie', 'sara'],
    ['susan', 'sue', 'suzy', 'susie'],
    ['teresa', 'tess', 'tessa', 'theresa'],
    ['valerie', 'val'],
    ['vanessa', 'nessa'],
    ['veronica', 'roni'],
    ['victoria', 'vicky', 'vickie', 'tori'],
    ['virginia', 'ginny', 'ginger'],
    ['vivian', 'viv'],
    ['winifred', 'winnie'],
    ['deborah', 'deb', 'debbie', 'debby', 'debra'],
    ['carolyn', 'carol', 'carrie', 'lynn'],
    ['nancy', 'nan'],
    ['barbara', 'barb', 'barbie', 'babs'],
    ['cassandra', 'cassie'],
    ['prudence', 'prue']
  ];
  var NICKNAME_MAP = (function () {
    var m = Object.create(null);
    for (var i = 0; i < NICKNAME_GROUPS.length; i++) {
      var g = NICKNAME_GROUPS[i], canon = g[0];
      if (!m[canon]) m[canon] = canon;
      for (var j = 1; j < g.length; j++) if (!m[g[j]]) m[g[j]] = canon;
    }
    return m;
  })();
  function canonFirst(first) {
    if (!first) return '';
    return NICKNAME_MAP[first] || first;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  var matchCache = new WeakMap();

  function namePartsOf(c) {
    var n = null, i;
    for (i = 0; i < c.props.length; i++) {
      if (c.props[i].name === 'N') { n = c.props[i].value; break; }
    }
    var first = '', last = '';
    if (n && (n[0] || n[1])) {
      last = normalizeName(n[0]);
      first = normalizeName(n[1]);
    } else {
      var parts = stripNameSuffixes(normalizeName(c.name)).split(' ').filter(Boolean);
      first = parts[0] || '';
      last = parts.length > 1 ? parts[parts.length - 1] : '';
    }
    return { first: first, last: last };
  }

  function matchData(c) {
    var md = matchCache.get(c);
    if (md) return md;
    var emails = new Set(), phones = new Set();
    c.emails.forEach(function (e) { var n = normalizeEmail(e.value); if (n) emails.add(n); });
    c.phones.forEach(function (p) { var k = phoneKey(p.value); if (k) phones.add(k); });
    var np = namePartsOf(c);
    var nameKey = stripNameSuffixes(normalizeName(c.name));
    var nickKey = np.first && np.last ? canonFirst(np.first) + ' ' + np.last : '';
    var sxKey = np.first && np.last ? soundex(np.first) + ':' + soundex(np.last) : '';
    var org = normalizeName(c.org);
    md = {
      emails: emails, phones: phones, first: np.first, last: np.last,
      nameKey: nameKey, nickKey: nickKey, sxKey: sxKey, org: org
    };
    matchCache.set(c, md);
    return md;
  }

  function intersects(a, b) {
    var small = a.size <= b.size ? a : b;
    var big = small === a ? b : a;
    for (var v of small) if (big.has(v)) return true;
    return false;
  }

  function scorePair(a, b) {
    var A = matchData(a), B = matchData(b);
    var score = 0, factors = [], warnings = [], strong = false;

    var sharedEmail = intersects(A.emails, B.emails);
    var sharedPhone = intersects(A.phones, B.phones);
    if (sharedEmail) { score += 50; factors.push('Shared email address'); strong = true; }
    if (sharedPhone) { score += 40; factors.push('Shared phone number'); strong = true; }

    var exactName = A.nameKey && A.nameKey === B.nameKey;
    var nickName = !exactName && A.nickKey && A.nickKey === B.nickKey;
    if (exactName) { score += 50; factors.push('Exact name match'); }
    else if (nickName) { score += 45; factors.push('Nickname name match'); }

    if (!exactName) {
      if (A.sxKey && A.sxKey === B.sxKey) { score += 35; factors.push('Similar sounding name'); }
      if (A.first && A.last && A.first[0] === B.first[0] && A.last === B.last) {
        score += 25; factors.push('Same first initial and last name');
      }
    }
    if (A.org && A.org === B.org) { score += 10; factors.push('Same organization'); }

    if (score > 100) score = 100;
    if (!strong) warnings.push('Name-only match');
    if (A.org && B.org && A.org !== B.org) warnings.push('Different organizations');
    if (!sharedEmail && sharedPhone && A.emails.size && B.emails.size) {
      warnings.push('Different email addresses');
    }
    return { score: score, factors: factors, warnings: warnings, strong: strong };
  }

  // Bucketed duplicate detection. Returns { groups, unique }.
  // groups: [{id, members, memberCount, confidence, factors, warnings, pairs,
  //           autoMergeSafe, status, merged}] sorted by confidence desc.
  // unique: contacts in no group, plus every isGroup (KIND:group) card.
  function findDuplicateGroups(contacts, opts) {
    opts = opts || {};
    var threshold = (typeof opts.threshold === 'number') ? opts.threshold : DEFAULT_THRESHOLD;

    var buckets = new Map();
    function add(k, i) {
      var arr = buckets.get(k);
      if (!arr) buckets.set(k, arr = []);
      arr.push(i);
    }
    contacts.forEach(function (c, i) {
      if (c.isGroup) return; // group cards are never deduped
      var md = matchData(c);
      md.emails.forEach(function (e) { add('e:' + e, i); });
      md.phones.forEach(function (p) { add('p:' + p, i); });
      if (md.nameKey) add('n:' + md.nameKey, i);
      if (md.nickKey) add('k:' + md.nickKey, i);
      if (md.sxKey) add('s:' + md.sxKey, i);
    });

    var parent = contacts.map(function (_, i) { return i; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

    var pairSeen = new Set();
    var edges = [];
    buckets.forEach(function (idxs) {
      if (idxs.length < 2 || idxs.length > BUCKET_LIMIT) return;
      for (var a = 0; a < idxs.length; a++) {
        for (var b = a + 1; b < idxs.length; b++) {
          var i = idxs[a], j = idxs[b];
          var key = i + '_' + j;
          if (pairSeen.has(key)) continue;
          pairSeen.add(key);
          var r = scorePair(contacts[i], contacts[j]);
          if (r.score >= threshold) {
            union(i, j);
            edges.push({ i: i, j: j, score: r.score, factors: r.factors, warnings: r.warnings, strong: r.strong });
          }
        }
      }
    });

    var inComp = new Set();
    edges.forEach(function (e) { inComp.add(e.i); inComp.add(e.j); });
    var comps = new Map();
    inComp.forEach(function (i) {
      var r = find(i);
      if (!comps.has(r)) comps.set(r, []);
      comps.get(r).push(i);
    });
    var edgesByRoot = new Map();
    edges.forEach(function (e) {
      var r = find(e.i);
      if (!edgesByRoot.has(r)) edgesByRoot.set(r, []);
      edgesByRoot.get(r).push(e);
    });

    var groups = [];
    comps.forEach(function (idxs, root) {
      idxs.sort(function (a, b) { return a - b; });
      var members = idxs.map(function (i) { return contacts[i]; });
      var conf = 0, factors = [], warnings = [], anyStrong = false, pairs = [];
      (edgesByRoot.get(root) || []).forEach(function (e) {
        conf = Math.max(conf, e.score);
        e.factors.forEach(function (f) { if (factors.indexOf(f) === -1) factors.push(f); });
        e.warnings.forEach(function (w) { if (warnings.indexOf(w) === -1) warnings.push(w); });
        if (e.strong) anyStrong = true;
        pairs.push({
          a: contacts[e.i], b: contacts[e.j], score: e.score,
          factors: e.factors, warnings: e.warnings
        });
      });
      groups.push({
        id: 'g' + (groups.length + 1),
        members: members,
        contacts: members, // UI contract alias — the SAME array, not a copy
        memberCount: members.length,
        confidence: conf,
        factors: factors,
        warnings: warnings,
        pairs: pairs,
        autoMergeSafe: conf >= 90 && anyStrong && warnings.length === 0,
        status: 'pending',
        merged: null
      });
    });
    groups.sort(function (a, b) { return b.confidence - a.confidence || b.memberCount - a.memberCount; });
    groups.forEach(function (g, i) { g.id = 'g' + (i + 1); });

    var unique = [];
    contacts.forEach(function (c, i) {
      if (c.isGroup || !inComp.has(i)) unique.push(c);
    });
    return { groups: groups, unique: unique };
  }

  // ---------------------------------------------------------------------------
  // Merging (superset merge — nothing silently lost)
  // ---------------------------------------------------------------------------

  // Property names the merger handles explicitly; everything else is treated
  // as an "unknown" prop and unioned by name+value so it is never dropped.
  var KNOWN = {
    VERSION: 1, FN: 1, N: 1, ORG: 1, TITLE: 1, BDAY: 1, PHOTO: 1, REV: 1,
    UID: 1, EMAIL: 1, TEL: 1, URL: 1, ADR: 1, IMPP: 1, NICKNAME: 1,
    CATEGORIES: 1, NOTE: 1, KIND: 1
  };

  function mkProp(name, params, value) {
    return { name: name, params: params || {}, value: value, rawLine: null };
  }

  function paramRichness(params) {
    var keys = Object.keys(params || {});
    var n = keys.length;
    if (params && params.TYPE) n += Array.isArray(params.TYPE) ? params.TYPE.length : 1;
    return n;
  }

  // Rank: master source first, then most props, then lowest _idx.
  function rankContacts(contacts) {
    return contacts.slice().sort(function (a, b) {
      var am = a._source === 'master' ? 0 : 1;
      var bm = b._source === 'master' ? 0 : 1;
      if (am !== bm) return am - bm;
      if (b.props.length !== a.props.length) return b.props.length - a.props.length;
      return (a._idx || 0) - (b._idx || 0);
    });
  }

  function cleanNote(n) {
    return String(n).replace(/\r\n|\r/g, '\n').replace(/\s+$/, '');
  }

  // THE critical routine: collect every note from every contact, drop only
  // exact duplicates and notes fully contained in a longer sibling, join the
  // survivors. Every line break preserved verbatim.
  function mergeNotes(ranked) {
    var notes = [];
    ranked.forEach(function (c) {
      c.notes.forEach(function (n) {
        var t = cleanNote(n);
        if (t) notes.push(t);
      });
    });
    var seen = new Set();
    notes = notes.filter(function (n) {
      if (seen.has(n)) return false;
      seen.add(n); return true;
    });
    notes = notes.filter(function (n, i) {
      return !notes.some(function (m, j) {
        return j !== i && m.length > n.length && m.indexOf(n) !== -1;
      });
    });
    return notes.join(NOTE_SEPARATOR);
  }

  function normUrl(v) { return String(v || '').trim().toLowerCase().replace(/\/+$/, ''); }
  function normAdr(v) { return normalizeName((Array.isArray(v) ? v : [v]).join(' ')); }
  function normItem(v) { return normalizeName(v); }

  // Union a multi-value field across ranked contacts, deduping by normalized
  // value and keeping the instance with richer TYPE params.
  function unionField(ranked, name, normFn) {
    var out = [], pos = new Map();
    ranked.forEach(function (c) {
      c.props.forEach(function (p) {
        if (p.name !== name) return;
        var vals = (Array.isArray(p.value) && COMMALIST[name]) ? p.value : [p.value];
        vals.forEach(function (v) {
          if (Array.isArray(v) ? !v.some(function (x) { return String(x).trim(); }) : !String(v).trim()) return;
          var key = normFn(v);
          if (!key) return;
          if (pos.has(key)) {
            var idx = pos.get(key);
            if (paramRichness(p.params) > paramRichness(out[idx].params)) {
              out[idx] = { value: v, params: p.params };
            }
          } else {
            pos.set(key, out.length);
            out.push({ value: v, params: p.params });
          }
        });
      });
    });
    return out;
  }

  function singletonCmp(name) {
    if (name === 'ORG' || name === 'N') return function (v) { return normalizeName(Array.isArray(v) ? v.join(' ') : v); };
    return function (v) { return normalizeName(v); };
  }
  function singletonDisplay(name, v) {
    if (name === 'N') {
      return [v[3], v[1], v[2], v[0], v[4]].filter(function (x) { return x && String(x).trim(); }).join(' ');
    }
    if (name === 'ORG') return orgString(v);
    return String(v);
  }

  // Singletons with note-appendix conflict preservation.
  var SINGLETONS = [
    { name: 'FN', label: 'Name' },
    { name: 'N', label: 'Name (structured)' },
    { name: 'ORG', label: 'Organization' },
    { name: 'TITLE', label: 'Title' },
    { name: 'BDAY', label: 'Birthday' },
    { name: 'REV', label: 'Revision' }
  ];

  function pickSingleton(ranked, name) {
    var cmp = singletonCmp(name);
    var winner = null, losers = [], seenLosers = new Set();
    ranked.forEach(function (c) {
      c.props.forEach(function (p) {
        if (p.name !== name) return;
        var v = p.value;
        var empty = Array.isArray(v)
          ? !v.some(function (x) { return String(x).trim(); })
          : !String(v).trim();
        if (empty) return;
        if (!winner) { winner = { value: v, params: p.params }; return; }
        if (cmp(v) !== cmp(winner.value)) {
          var key = cmp(v);
          if (!seenLosers.has(key)) { seenLosers.add(key); losers.push(v); }
        }
      });
    });
    return { winner: winner, losers: losers };
  }

  // Union distinct binary props (PHOTO et al.) by raw value.
  function unionBinary(ranked, name) {
    var out = [], seen = new Set();
    ranked.forEach(function (c) {
      c.props.forEach(function (p) {
        if (p.name !== name) return;
        var key = String(p.value);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push({ value: p.value, params: p.params });
      });
    });
    return out;
  }

  // Superset-merge an array of contact objects into one. Idempotent: merging
  // a single contact returns it unchanged; merging an already-merged set
  // regenerates the same content.
  function mergeContacts(contacts) {
    if (!contacts || contacts.length === 0) return null;
    if (contacts.length === 1) return contacts[0];
    var ranked = rankContacts(contacts);
    var i, p;

    // --- notes (critical) ---
    var mergedNote = mergeNotes(ranked);

    // --- multi-value unions ---
    var emails = unionField(ranked, 'EMAIL', normalizeEmail);
    var tels = unionField(ranked, 'TEL', normalizePhone);
    var urls = unionField(ranked, 'URL', normUrl);
    var adrs = unionField(ranked, 'ADR', normAdr);
    var impps = unionField(ranked, 'IMPP', normalizeEmail);
    var nicknames = unionField(ranked, 'NICKNAME', normItem);
    var categories = unionField(ranked, 'CATEGORIES', normItem);
    var photos = unionBinary(ranked, 'PHOTO');

    // --- singletons with conflict appendix ---
    var winners = {}, appendixLines = [], seenLine = new Set();
    SINGLETONS.forEach(function (s) {
      var r = pickSingleton(ranked, s.name);
      winners[s.name] = r.winner;
      r.losers.forEach(function (v) {
        var line = s.label + ': ' + singletonDisplay(s.name, v);
        if (!seenLine.has(line)) { seenLine.add(line); appendixLines.push(line); }
      });
    });

    // --- UID: winner + losers preserved as X-MERGED-UID ---
    var uid = pickSingleton(ranked, 'UID');
    winners.UID = uid.winner;
    var mergedUids = [], seenUid = new Set();
    uid.losers.forEach(function (v) {
      var s = String(v);
      if (!seenUid.has(s)) { seenUid.add(s); mergedUids.push(s); }
    });

    // --- unknown / X- props: union by name+value ---
    var unknowns = [], seenUnknown = new Set();
    ranked.forEach(function (c) {
      c.props.forEach(function (p) {
        if (KNOWN[p.name]) return;
        var key = p.name + '|' + (Array.isArray(p.value) ? p.value.join(';') : String(p.value));
        if (seenUnknown.has(key)) return;
        seenUnknown.add(key);
        unknowns.push(p);
      });
    });

    // --- conflict appendix into the note (never silently drop losers) ---
    if (appendixLines.length) {
      var blockLines = appendixLines.filter(function (line) {
        return mergedNote.indexOf(line) === -1; // idempotency: don't re-add
      });
      if (blockLines.length) {
        var block = APPENDIX_HEADER + '\n' + blockLines.join('\n');
        mergedNote = mergedNote ? mergedNote + '\n\n' + block : block;
      }
    }

    // --- KIND:group survives only if every member is a group card ---
    var kind = null;
    if (ranked.every(function (c) { return c.isGroup; })) {
      for (i = 0; i < ranked.length && !kind; i++) {
        for (var k = 0; k < ranked[i].props.length; k++) {
          if (ranked[i].props[k].name === 'KIND') { kind = ranked[i].props[k]; break; }
        }
      }
    }

    // --- rebuild props in a stable, canonical order ---
    var props = [];
    props.push(mkProp('VERSION', {}, '3.0'));
    if (winners.FN) props.push(mkProp('FN', winners.FN.params, winners.FN.value));
    if (winners.N) props.push(mkProp('N', winners.N.params, padComps(winners.N.value, 5)));
    nicknames.forEach(function (n) { props.push(mkProp('NICKNAME', n.params, [n.value])); });
    photos.forEach(function (ph) { props.push(mkProp('PHOTO', ph.params, ph.value)); });
    if (winners.BDAY) props.push(mkProp('BDAY', winners.BDAY.params, winners.BDAY.value));
    if (winners.ORG) props.push(mkProp('ORG', winners.ORG.params, winners.ORG.value));
    if (winners.TITLE) props.push(mkProp('TITLE', winners.TITLE.params, winners.TITLE.value));
    emails.forEach(function (e) { props.push(mkProp('EMAIL', e.params, e.value)); });
    tels.forEach(function (t) { props.push(mkProp('TEL', t.params, t.value)); });
    impps.forEach(function (m) { props.push(mkProp('IMPP', m.params, m.value)); });
    urls.forEach(function (u2) { props.push(mkProp('URL', u2.params, u2.value)); });
    adrs.forEach(function (a) { props.push(mkProp('ADR', a.params, padComps(a.value, 7))); });
    if (categories.length) {
      props.push(mkProp('CATEGORIES', categories[0].params, categories.map(function (c2) { return c2.value; })));
    }
    if (mergedNote) props.push(mkProp('NOTE', {}, mergedNote));
    if (winners.UID) props.push(mkProp('UID', winners.UID.params, winners.UID.value));
    if (winners.REV) props.push(mkProp('REV', winners.REV.params, winners.REV.value));
    if (kind) props.push(kind);
    mergedUids.forEach(function (u3) { props.push(mkProp('X-MERGED-UID', {}, u3)); });
    unknowns.forEach(function (u4) { props.push(u4); });

    var merged = deriveFields(emptyContact(props));
    merged._source = 'merged';
    merged._sourceIdx = ranked[0]._sourceIdx;
    merged._idx = ranked[0]._idx;
    return merged;
  }

  function padComps(arr, n) {
    var out = (Array.isArray(arr) ? arr : [arr]).slice();
    while (out.length < n) out.push('');
    return out;
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  function propLine(p) {
    var header = p.name; // itemN. group prefixes intentionally not re-emitted
    var params = p.params || {};
    Object.keys(params).forEach(function (k) {
      if (k === 'CHARSET') return; // we always emit UTF-8
      var v = params[k];
      if (k === 'ENCODING') {
        var e = paramStr(v).toUpperCase();
        if (e === 'B' || e === 'BASE64') header += ';ENCODING=b';
        return; // quoted-printable is dropped: values are stored decoded
      }
      var vals = Array.isArray(v) ? v : [v];
      header += ';' + k + '=' + vals.map(function (x) {
        return String(x).replace(/[;:,"]/g, '-');
      }).join(',');
    });
    var value;
    var enc = paramStr(params.ENCODING).toUpperCase();
    if (enc === 'B' || enc === 'BASE64') {
      value = String(p.value); // base64 kept raw
    } else if (Array.isArray(p.value)) {
      var sep = COMMALIST[p.name] ? ',' : ';';
      value = p.value.map(escapeText).join(sep);
    } else {
      value = escapeText(p.value == null ? '' : String(p.value));
    }
    return foldLine(header + ':' + value);
  }

  // Serialize one contact to a valid vCard 3.0 block with CRLF endings.
  function contactToVCard(contact) {
    var lines = ['BEGIN:VCARD', 'VERSION:3.0'];
    (contact.props || []).forEach(function (p) {
      if (!p || !p.name) return;
      if (p.name === 'VERSION' || p.name === 'BEGIN' || p.name === 'END') return;
      lines.push(propLine(p));
    });
    lines.push('END:VCARD');
    return lines.join('\r\n') + '\r\n';
  }

  // approved groups -> merged contact; skipped/pending -> originals untouched;
  // plus all uniques. Returns { contacts, vcfText }.
  function buildExport(groups, uniqueContacts) {
    var out = [];
    (groups || []).forEach(function (g) {
      if (g.status === 'approved') {
        var m = g.merged || mergeContacts(g.members);
        g.merged = m;
        if (m) out.push(m);
      } else {
        g.members.forEach(function (c) { out.push(c); });
      }
    });
    (uniqueContacts || []).forEach(function (c) { out.push(c); });
    return { contacts: out, vcfText: out.map(contactToVCard).join('') };
  }

  function csvCell(s) {
    s = s == null ? '' : String(s);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function addrDisplay(v) {
    var comps = Array.isArray(v) ? v : [v];
    return comps.filter(function (x) { return String(x).trim(); }).join(', ');
  }

  function generateCSV(contacts) {
    var rows = [[
      'Name', 'Nickname', 'Organization', 'Title', 'Birthday',
      'Emails', 'Phones', 'Addresses', 'URLs', 'Notes', 'IsGroup', 'Source'
    ].join(',')];
    (contacts || []).forEach(function (c) {
      rows.push([
        csvCell(c.name),
        csvCell(c.nickname),
        csvCell(c.org),
        csvCell(c.title),
        csvCell(c.birthday),
        csvCell(c.emails.map(function (e) { return e.value; }).join('; ')),
        csvCell(c.phones.map(function (p) { return p.value; }).join('; ')),
        csvCell(c.addresses.map(function (a) { return addrDisplay(a.value); }).join(' | ')),
        csvCell(c.urls.map(function (u) { return u.value; }).join('; ')),
        csvCell(c.notes.join('\n\n')),
        c.isGroup ? 'yes' : 'no',
        csvCell(c._source || '')
      ].join(','));
    });
    return rows.join('\r\n') + '\r\n';
  }

  function generateJSON(contacts) {
    return JSON.stringify(contacts || [], null, 2);
  }

  // Plain-text merge plan / audit trail suitable for dry-run review.
  function generateAuditLog(groups, stats) {
    var L = [];
    L.push('CONTACT DEDUPLICATION - MERGE PLAN / AUDIT LOG');
    L.push('Generated: ' + new Date().toISOString());
    L.push('');
    stats = stats || {};
    Object.keys(stats).forEach(function (k) { L.push(k + ': ' + stats[k]); });
    var approved = (groups || []).filter(function (g) { return g.status === 'approved'; });
    var skipped = (groups || []).filter(function (g) { return g.status === 'skipped'; });
    var pending = (groups || []).filter(function (g) { return g.status === 'pending'; });
    L.push('Groups: ' + (groups || []).length +
      ' (approved: ' + approved.length + ', pending review: ' + pending.length +
      ', skipped: ' + skipped.length + ')');
    (groups || []).forEach(function (g, gi) {
      L.push('');
      L.push('------------------------------------------------------------');
      L.push('GROUP ' + (gi + 1) +
        '  confidence=' + g.confidence +
        '  status=' + String(g.status || 'pending').toUpperCase() +
        (g.autoMergeSafe ? '  [AUTO-MERGE SAFE]' : '  [REVIEW REQUIRED]'));
      L.push('Members:');
      g.members.forEach(function (m) {
        L.push('  - ' + (m.name || '(no name)') +
          '  [source=' + (m._source || '?') + ', index=' + m._sourceIdx +
          (m.isGroup ? ', GROUP CARD' : '') + ']');
      });
      if (g.factors && g.factors.length) L.push('Factors: ' + g.factors.join('; '));
      if (g.warnings && g.warnings.length) L.push('Warnings: ' + g.warnings.join('; '));
      var merged = g.merged || (g.status === 'approved' ? mergeContacts(g.members) : null);
      if (merged) {
        var noteLen = merged.notes.reduce(function (s, n) { return s + n.length; }, 0);
        var noteLines = merged.notes.reduce(function (s, n) { return s + n.split('\n').length; }, 0);
        L.push('Resulting note: ' + noteLen + ' chars, ' + noteLines + ' lines');
      } else {
        var memberNotes = g.members.reduce(function (s, m) {
          return s + m.notes.reduce(function (s2, n) { return s2 + n.length; }, 0);
        }, 0);
        L.push('Member notes (unmerged): ' + memberNotes + ' chars');
      }
    });
    L.push('');
    return L.join('\n');
  }

  // Verify no note text was lost between a before and after contact set.
  // Identities matched by normalized name, shared email, or shared phone.
  // Returns { before, after, losses:[names] }.
  function noteIntegrityReport(beforeContacts, afterContacts) {
    function agg(cs) {
      var withNotes = 0, chars = 0, lines = 0;
      (cs || []).forEach(function (c) {
        var has = false;
        c.notes.forEach(function (n) {
          if (!n || !n.trim()) return;
          has = true;
          chars += n.length;
          lines += n.split('\n').length;
        });
        if (has) withNotes++;
      });
      return { contacts: (cs || []).length, withNotes: withNotes, chars: chars, lines: lines };
    }

    // Identity indexes: every key maps to ALL contacts carrying it, so a
    // before-contact is matched against every candidate identity (its merged
    // successor OR its unmerged original) and cleared if any candidate holds
    // all of its notes.
    var byEmail = new Map(), byPhone = new Map(), byName = new Map(), byNick = new Map();
    function idx(map, k, c) {
      if (!k) return;
      var arr = map.get(k);
      if (!arr) map.set(k, arr = []);
      arr.push(c);
    }
    (afterContacts || []).forEach(function (c) {
      var md = matchData(c);
      md.emails.forEach(function (e) { idx(byEmail, e, c); });
      md.phones.forEach(function (p) { idx(byPhone, p, c); });
      idx(byName, md.nameKey, c);
      idx(byNick, md.nickKey, c);
    });

    function holdsAllNotes(cand, notes) {
      var hay = cand.notes.join(NOTE_SEPARATOR).replace(/\r\n|\r/g, '\n');
      return notes.every(function (n) {
        if (!n || !n.trim()) return true;
        return hay.indexOf(cleanNote(n)) !== -1;
      });
    }

    var losses = [];
    (beforeContacts || []).forEach(function (b) {
      if (!b.notes.some(function (n) { return n && n.trim(); })) return;
      var md = matchData(b);
      var cands = new Set();
      md.emails.forEach(function (e) { (byEmail.get(e) || []).forEach(function (c) { cands.add(c); }); });
      md.phones.forEach(function (p) { (byPhone.get(p) || []).forEach(function (c) { cands.add(c); }); });
      (byName.get(md.nameKey) || []).forEach(function (c) { cands.add(c); });
      (byNick.get(md.nickKey) || []).forEach(function (c) { cands.add(c); });
      var ok = false;
      for (var cand of cands) {
        if (holdsAllNotes(cand, b.notes)) { ok = true; break; }
      }
      if (!ok) losses.push(b.name || '(unnamed #' + (b._idx >= 0 ? b._idx : '?') + ')');
    });

    return { before: agg(beforeContacts), after: agg(afterContacts), losses: losses };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    VERSION: ENGINE_VERSION,
    NOTE_SEPARATOR: NOTE_SEPARATOR,
    parseVCards: parseVCards,
    findDuplicateGroups: findDuplicateGroups,
    mergeContacts: mergeContacts,
    contactToVCard: contactToVCard,
    buildExport: buildExport,
    generateCSV: generateCSV,
    generateJSON: generateJSON,
    generateAuditLog: generateAuditLog,
    noteIntegrityReport: noteIntegrityReport,
    normalizeName: normalizeName,
    normalizeEmail: normalizeEmail,
    normalizePhone: normalizePhone,
    // extra utilities (used by the test suite)
    soundex: soundex,
    escapeText: escapeText,
    unescapeText: unescapeText,
    foldLine: foldLine
  };
});
