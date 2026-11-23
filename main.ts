// mend: one command-line tool that applies AI-written edits in four formats
// (unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON tool calls) to
// a tree of text files, exactly as SPEC.md says. Node 22, standard library
// only, deterministic: the same check gives the same exit code, stdout and
// files every run. Run as `node main.ts [options] [PATCH]`.
//
// When MAKEFUN_ENV_URL is set the run is a trial: the kit's runner reads the
// checks from that env and runs this file on each one (see runner.ts).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A patch the reader cannot read: `error: parse <line>`, exit 2. */
class ParseFault extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit that failed: `error: <code> <path>`, exit 1, nothing written. */
class EditFailure extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const trimEnd = (s: string): string => s.replace(/[ \t\r]+$/, '');

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and
 *  the empty piece after a final `\n` dropped. */
function splitPatchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 *  `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's text, seen as lines: its line break is CRLF when its first line
 *  feed follows a carriage return, LF otherwise; it ends with a line break
 *  when its text ends with that break, and the empty piece after it is not a
 *  line. An empty file has no lines and no final break. */
interface FileView {
  lines: string[];
  br: string;
  finalBr: boolean;
}

function parseFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { lines, br, finalBr };
}

function renderFile(v: FileView): string {
  if (v.lines.length === 0) return '';
  return v.lines.join(v.br) + (v.finalBr ? v.br : '');
}

/** The tree as the edits leave it: `state` holds every path an edit touched
 *  (null: deleted); anything else is read from disk, once, as it was before
 *  the patch. Writes happen only after every edit ran without failing. */
class Tree {
  private readonly disk = new Map<string, string | null>();
  private state = new Map<string, string | null>();

  before(p: string): string | null {
    if (!this.disk.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.disk.set(p, v);
    }
    return this.disk.get(p)!;
  }

  get(p: string): string | null {
    return this.state.has(p) ? this.state.get(p)! : this.before(p);
  }

  set(p: string, v: string | null): void {
    this.state.set(p, v);
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.state);
  }

  restore(s: Map<string, string | null>): void {
    this.state = new Map(s);
  }

  touched(): string[] {
    return [...this.state.keys()];
  }

  after(p: string): string | null {
    return this.state.get(p)!;
  }
}

/** One edit: it reads and writes the tree, and records a move it made. */
type EditFn = (tree: Tree, moves: [string, string][]) => void;

// ---------------------------------------------------------------------------
// Matching lines (SPEC.md section 5)
// ---------------------------------------------------------------------------

/** A line as a tier reads it: tier 0 exact, tier 1 trailing spaces and tabs
 *  removed, tier 2 leading and trailing spaces and tabs removed. */
function tierLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position at which `oldLines` occurs in `fileLines` at `tier`, at or
 *  after `from`; occurrences may overlap. */
function occurrencesAt(fileLines: string[], oldLines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  const n = oldLines.length;
  if (n === 0) return out;
  for (let i = from; i + n <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < n; j++) {
      if (tierLine(fileLines[i + j], tier) !== tierLine(oldLines[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which `oldLines`
 *  occurs at least once at or after `from`, with every such occurrence. */
function findTier(
  fileLines: string[],
  oldLines: string[],
  from: number,
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(fileLines, oldLines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line
 *  (its index in O is `oIdx`); any other line is written as the patch wrote
 *  it, re-indented at tier 2. */
interface NewLine {
  text: string;
  context: boolean;
  oIdx: number;
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** The lines that replace the `k` matched lines at `start`. */
function buildReplacement(
  newLines: NewLine[],
  oldLines: string[],
  fileLines: string[],
  start: number,
  tier: number,
): string[] {
  const f = leadingWs(fileLines[start] ?? '');
  const p = leadingWs(oldLines[0] ?? '');
  const out: string[] = [];
  for (const nl of newLines) {
    if (nl.context) {
      out.push(fileLines[start + nl.oIdx]);
      continue;
    }
    const t = nl.text;
    if (tier === 2 && !/^[ \t]*$/.test(t) && t.startsWith(p)) out.push(f + t.slice(p.length));
    else out.push(t);
  }
  return out;
}

/** Split a hunk or chunk body into its old lines O (context and `-` lines)
 *  and its new lines N (context and `+` lines), each in body order. */
function splitBody(body: BodyLine[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  const ctxO: number[] = [];
  for (const b of body) {
    if (b.kind === ' ' || b.kind === '-') {
      if (b.kind === ' ') ctxO.push(oldLines.length);
      oldLines.push(b.text);
    }
  }
  let seen = 0;
  for (const b of body) {
    if (b.kind === ' ') {
      newLines.push({ text: b.text, context: true, oIdx: ctxO[seen] });
      seen += 1;
    } else if (b.kind === '+') {
      newLines.push({ text: b.text, context: false, oIdx: -1 });
    }
  }
  return { oldLines, newLines };
}

/** One line of a hunk or chunk body: ` ` context, `-` old, `+` new, `\` a
 *  backslash line (as in `\ No newline at end of file`). */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function bodyLineOf(line: string): BodyLine {
  if (line === '') return { kind: ' ', text: '' };
  const c = line[0];
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return { kind: c, text: line.slice(1) };
  return { kind: ' ', text: line };
}

// ---------------------------------------------------------------------------
// Invocation and format detection (SPEC.md sections 1 and 4)
// ---------------------------------------------------------------------------

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/** The command line, or null on a usage error: an argument that starts with
 *  `-` and is not `-` and not one of the options (before `--`), an option
 *  given twice, a `--format` value other than the five names, or more than
 *  one positional argument. Options and PATCH may come in any order, and
 *  `--` ends the options. */
function parseArgs(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let ended = false;
  const pos: string[] = [];
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (format !== null || !FORMATS.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 ? null : pos[0] };
}

/** With `--format=auto` the format is the first of these that holds: the
 *  first non-blank line, trimmed, is `*** Begin Patch` (v4a); the first
 *  non-whitespace character of the first non-blank line is `[` or `{`
 *  (json); some line, trailing whitespace removed, is `<<<<<<< SEARCH`
 *  (search-replace); some line starts with `diff --git `, or some line starts
 *  with `--- ` and the line after it starts with `+++ ` (unified). */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first].trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => trimEnd(l) === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

interface Hunk {
  /** The `-A` number of the header: the old start line, 1-based. */
  a: number;
  body: BodyLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  backslashAfterLast: boolean;
}

interface Section {
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  /** A `+++ ` line on its own in the header names the new path. */
  loneNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string | null, diffNew: string | null): Section {
  return {
    diffOld,
    diffNew,
    hasPair: false,
    pairOld: null,
    pairNew: null,
    loneNew: null,
    renameOld: null,
    renameNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  };
}

/** The path after `--- ` or `+++ `: the text after the four characters, up
 *  to the first tab, with surrounding spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0].trim();
}

/** A leading `a/` or `b/` is removed from a path. */
function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Read every section of a unified diff. A section starts at a
 *  `diff --git a/<X> b/<Y>` line, or at a `--- ` line followed by a `+++ ` line
 *  that is not already part of a section's header. */
function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      cur = newSection(m[1], m[2]);
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader) {
        if (!cur.hasPair) {
          cur.hasPair = true;
          const o = headerPath(line);
          const n = headerPath(lines[i + 1]);
          cur.pairOld = o === '/dev/null' ? null : stripPrefix(o);
          cur.pairNew = n === '/dev/null' ? null : stripPrefix(n);
        }
        i += 2;
        continue;
      }
      cur = newSection(null, null);
      cur.hasPair = true;
      const o = headerPath(line);
      const n = headerPath(lines[i + 1]);
      cur.pairOld = o === '/dev/null' ? null : stripPrefix(o);
      cur.pairNew = n === '/dev/null' ? null : stripPrefix(n);
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new ParseFault(i + 1);
      if (cur === null) throw new ParseFault(i + 1);
      inHeader = false;
      const hunk = readHunk(lines, i + 1);
      cur.hunks.push(hunk.hunk);
      i = hunk.next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('+++ ')) {
        if (cur.loneNew === null && !cur.hasPair) cur.loneNew = stripPrefix(headerPath(line));
      } else if (line.startsWith('rename from ')) {
        const p = line.slice('rename from '.length).trim();
        if (p !== '') cur.renameOld = p;
      } else if (line.startsWith('rename to ')) {
        const p = line.slice('rename to '.length).trim();
        if (p !== '') cur.renameNew = p;
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }
  return sections;
}

/** A hunk's body: the lines after the header that start with ` `, `-`, `+`
 *  or `\`, or are empty (an empty line is a context line whose text is
 *  empty). The body ends at the first other line, at a `diff --git ` line, at
 *  a `--- ` line followed by a `+++ ` line, or at the end of the patch;
 *  empty lines at the end of a body are not part of it. */
function readHunk(lines: string[], start: number): { hunk: Hunk; next: number } {
  const body: BodyLine[] = [];
  let j = start;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
      body.push(bodyLineOf(l));
      j += 1;
    } else {
      break;
    }
  }
  while (body.length > 0 && body[body.length - 1].kind === ' ' && body[body.length - 1].text === '') body.pop();
  let backslashAfterLast = false;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k].kind === ' ' || body[k].kind === '+') {
      backslashAfterLast = k + 1 < body.length && body[k + 1].kind === '\\';
      break;
    }
  }
  const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[start - 1]);
  return { hunk: { a: Number(header![1]), body, backslashAfterLast }, next: j };
}

// ---------------------------------------------------------------------------
// Applying unified sections (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** Apply a section's hunks, in order, each to the result of the ones before
 *  it, to a file's lines. `d` is the sum over this section's hunks applied so
 *  far of (N's length minus O's length). */
function applyHunks(
  hunks: Hunk[],
  lines: string[],
  finalBr: boolean,
  strict: boolean,
  path: string,
): { lines: string[]; finalBr: boolean } {
  let cur = [...lines];
  let curFinal = finalBr;
  let d = 0;
  for (const h of hunks) {
    const { oldLines, newLines } = splitBody(h.body);
    if (oldLines.length === 0) {
      const at = Math.max(0, Math.min(h.a + d, cur.length));
      const ins = newLines.map((nl) => nl.text);
      cur.splice(at, 0, ...ins);
      if (at === cur.length - ins.length) curFinal = !h.backslashAfterLast;
      d += ins.length;
      continue;
    }
    const found = findTier(cur, oldLines, 0, strict);
    if (found === null) throw new EditFailure('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0];
    let bestDist = Math.abs(best - target);
    for (const p of found.occ) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const repl = buildReplacement(newLines, oldLines, cur, best, found.tier);
    const runsToEnd = best + oldLines.length === cur.length;
    cur.splice(best, oldLines.length, ...repl);
    if (runsToEnd) curFinal = !h.backslashAfterLast;
    d += newLines.length - oldLines.length;
  }
  return { lines: cur, finalBr: curFinal };
}

/** The section's paths: a `---`/`+++` pair names both; otherwise `rename
 *  from`/`rename to` name them when they are there, else the `diff --git`
 *  paths. A lone `+++ ` line in the header names the new path. */
function sectionPaths(sec: Section): { oldPath: string | null; newPath: string | null } {
  if (sec.hasPair) return { oldPath: sec.pairOld, newPath: sec.pairNew };
  return {
    oldPath: sec.renameOld ?? sec.diffOld,
    newPath: sec.loneNew ?? sec.renameNew ?? sec.diffNew,
  };
}

/** One section is one edit. A creation is the `+` lines of all its hunks; a
 *  deletion deletes and its hunks are not read; a move applies the hunks to
 *  the old file's lines and writes the result at the new path; otherwise the
 *  one path is changed. */
function makeUnifiedEdit(sec: Section, strict: boolean): EditFn {
  return (tree, moves) => {
    const { oldPath, newPath } = sectionPaths(sec);
    if (oldPath !== null && !isSafe(oldPath)) throw new EditFailure('unsafe', oldPath);
    if (newPath !== null && !isSafe(newPath)) throw new EditFailure('unsafe', newPath);
    if (sec.isCreate || oldPath === null) {
      if (newPath === null) return;
      if (tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
      const out: string[] = [];
      let finalBr = true;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const b of h.body) {
          if (b.kind === '+') {
            out.push(b.text);
            hasPlus = true;
          }
        }
        if (hasPlus) finalBr = !h.backslashAfterLast;
      }
      tree.set(newPath, out.length === 0 ? '' : out.join('\n') + (finalBr ? '\n' : ''));
      return;
    }
    if (sec.isDelete || newPath === null) {
      if (tree.get(oldPath) === null) throw new EditFailure('missing', oldPath);
      tree.set(oldPath, null);
      return;
    }
    if (oldPath !== newPath) {
      const cur = tree.get(oldPath);
      if (cur === null) throw new EditFailure('missing', oldPath);
      if (tree.get(newPath) !== null) throw new EditFailure('exists', newPath);
      const view = parseFile(cur);
      const done = applyHunks(sec.hunks, view.lines, view.finalBr, strict, oldPath);
      tree.set(newPath, renderFile({ lines: done.lines, br: view.br, finalBr: done.finalBr }));
      tree.set(oldPath, null);
      moves.push([oldPath, newPath]);
      return;
    }
    const cur = tree.get(oldPath);
    if (cur === null) throw new EditFailure('missing', oldPath);
    const view = parseFile(cur);
    const done = applyHunks(sec.hunks, view.lines, view.finalBr, strict, oldPath);
    tree.set(oldPath, renderFile({ lines: done.lines, br: view.br, finalBr: done.finalBr }));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

/** Read every SEARCH/REPLACE block. The path is the nearest line before the
 *  `<<<<<<< SEARCH` line, and after the previous block's `>>>>>>> REPLACE`
 *  line (or the start of the patch), that is not blank and, its surrounding
 *  whitespace removed, does not start with three backticks; the path is that
 *  line with its surrounding whitespace removed. When there is no such line
 *  the block takes the previous block's path; the first block with none is a
 *  parse fault at its SEARCH line. */
function parseSearchReplace(lines: string[], strict: boolean): EditFn[] {
  const edits: EditFn[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (trimEnd(lines[i]) !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFault(searchIdx + 1);
      path = prevPath;
    }
    let eqIdx = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '=======') {
        eqIdx = j;
        break;
      }
      if (trimEnd(lines[j]) === '>>>>>>> REPLACE') break;
    }
    if (eqIdx === -1) throw new ParseFault(searchIdx + 1);
    let endIdx = -1;
    for (let j = eqIdx + 1; j < lines.length; j++) {
      if (trimEnd(lines[j]) === '>>>>>>> REPLACE') {
        endIdx = j;
        break;
      }
    }
    if (endIdx === -1) throw new ParseFault(searchIdx + 1);
    const oldLines = lines.slice(searchIdx + 1, eqIdx);
    const newLines = lines.slice(eqIdx + 1, endIdx);
    edits.push(makeSearchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = endIdx;
    i = endIdx + 1;
  }
  return edits;
}

/** One block is one edit. Empty old lines create the file; otherwise the
 *  file exists and the old lines occur at their tier exactly once. */
function makeSearchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): EditFn {
  return (tree) => {
    if (!isSafe(path)) throw new EditFailure('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFailure('missing', path);
    const view = parseFile(cur);
    const found = findTier(view.lines, oldLines, 0, strict);
    if (found === null) throw new EditFailure('no-match', path);
    if (found.occ.length > 1) throw new EditFailure('ambiguous', path);
    const start = found.occ[0];
    const repl = buildReplacement(
      newLines.map((t) => ({ text: t, context: false, oIdx: -1 })),
      oldLines,
      view.lines,
      start,
      found.tier,
    );
    const out = [...view.lines];
    out.splice(start, oldLines.length, ...repl);
    tree.set(path, renderFile({ lines: out, br: view.br, finalBr: view.finalBr }));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  /** The anchor text after `@@`, or null when the chunk has none. */
  anchor: string | null;
  /** Anchored to the end of the file by a `*** End of File` line. */
  eof: boolean;
  body: BodyLine[];
}

/** Read every V4A section. The first non-blank line is `*** Begin Patch`
 *  and the last non-blank line is `*** End Patch`; blank lines at the end
 *  of a section are not part of it. */
function parseV4a(lines: string[], strict: boolean): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFault(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!isBlank(lines[k])) {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const edits: EditFn[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const m = /^\*\*\* (Add|Delete|Update) File: (.*)$/.exec(line);
    if (m === null) throw new ParseFault(i + 1);
    const kind = m[1];
    const path = m[2].trim();
    let j = i + 1;
    while (j < last) {
      const l = lines[j];
      if (/^\*\*\* (Add|Delete|Update) File: /.test(l)) break;
      j += 1;
    }
    const raw = lines.slice(i + 1, j).map((text, k) => ({ text, no: i + 2 + k }));
    while (raw.length > 0 && isBlank(raw[raw.length - 1].text)) raw.pop();
    if (kind === 'Add') edits.push(makeV4aAdd(path, raw));
    else if (kind === 'Delete') edits.push(makeV4aDelete(path, raw));
    else edits.push(makeV4aUpdate(path, raw, i + 1, strict));
    i = j;
  }
  return edits;
}

function makeV4aAdd(path: string, raw: { text: string; no: number }[]): EditFn {
  const fileLines: string[] = [];
  for (const r of raw) {
    if (r.text === '') fileLines.push('');
    else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
    else throw new ParseFault(r.no);
  }
  return (tree) => {
    if (!isSafe(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) !== null) throw new EditFailure('exists', path);
    tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function makeV4aDelete(path: string, raw: { text: string; no: number }[]): EditFn {
  for (const r of raw) throw new ParseFault(r.no);
  return (tree) => {
    if (!isSafe(path)) throw new EditFailure('unsafe', path);
    if (tree.get(path) === null) throw new EditFailure('missing', path);
    tree.set(path, null);
  };
}

/** An Update File section may have `*** Move to: <path>` as its first line,
 *  then chunks. A chunk starts at an `@@` line or, for the first chunk, at a
 *  body line. A `*** End of File` line ends a chunk and anchors it to the
 *  end of the file. An Update File section with no chunk and no `*** Move to:`
 *  is a parse fault at its Update File line. */
function makeV4aUpdate(path: string, raw: { text: string; no: number }[], updateLine: number, strict: boolean): EditFn {
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0].text.startsWith('*** Move to: ')) {
    moveTo = raw[0].text.slice('*** Move to: '.length).trim();
    idx = 1;
  }
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; idx < raw.length; idx++) {
    const r = raw[idx];
    const line = r.text;
    if (line.startsWith('@@')) {
      close();
      cur = { anchor: line.slice(2).trim(), eof: false, body: [] };
      continue;
    }
    if (line.trim() === '*** End of File') {
      if (cur === null) throw new ParseFault(r.no);
      cur.eof = true;
      close();
      continue;
    }
    if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+')) {
      if (cur === null) {
        if (chunks.length !== 0) throw new ParseFault(r.no);
        cur = { anchor: null, eof: false, body: [] };
      }
      cur.body.push(bodyLineOf(line));
      continue;
    }
    throw new ParseFault(r.no);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new ParseFault(updateLine);
  return (tree, moves) => {
    if (!isSafe(path)) throw new EditFailure('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFailure('unsafe', moveTo);
    const curText = tree.get(path);
    if (curText === null) throw new EditFailure('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFailure('exists', moveTo);
    const view = parseFile(curText);
    let fileLines = [...view.lines];
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        let foundAt: number | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          for (let k = cursor; k < fileLines.length; k++) {
            if (tierLine(fileLines[k], t) === tierLine(ch.anchor, t)) {
              foundAt = k;
              break;
            }
          }
          if (foundAt !== null) break;
        }
        if (foundAt === null) throw new EditFailure('no-match', path);
        cursor = foundAt + 1;
      }
      const { oldLines, newLines } = splitBody(ch.body);
      if (oldLines.length === 0) {
        const at = ch.eof ? fileLines.length : cursor;
        const ins = newLines.map((nl) => nl.text);
        fileLines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let chosen: { tier: number; start: number } | null = null;
      for (const t of tiers) {
        const occ = occurrencesAt(fileLines, oldLines, t, cursor);
        const usable = ch.eof ? occ.filter((s) => s + oldLines.length === fileLines.length) : occ;
        if (usable.length > 0) {
          chosen = { tier: t, start: usable[0] };
          break;
        }
      }
      if (chosen === null) throw new EditFailure('no-match', path);
      const repl = buildReplacement(newLines, oldLines, fileLines, chosen.start, chosen.tier);
      fileLines.splice(chosen.start, oldLines.length, ...repl);
      cursor = chosen.start + repl.length;
    }
    const out = renderFile({ lines: fileLines, br: view.br, finalBr: view.finalBr });
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one: a string `path` and a
 *  `command` of `create`, `str_replace` or `insert`, with the keys each
 *  command needs, of the right types. Keys other than those are ignored. */
function makeJsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(path)) throw new EditFailure('unsafe', path);
      if (tree.get(path) !== null) throw new EditFailure('exists', path);
      tree.set(path, text);
    };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!isSafe(path)) throw new EditFailure('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new EditFailure('missing', path);
      const nl = cur.indexOf('\n');
      const crlf = nl > 0 && cur[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(cur);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFailure('no-match', path);
      if (count > 1) throw new EditFailure('ambiguous', path);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.set(path, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    const lineNo = o.insert_line;
    const add = splitPatchLines(o.new_str);
    return (tree) => {
      if (!isSafe(path)) throw new EditFailure('unsafe', path);
      const cur = tree.get(path);
      if (cur === null) throw new EditFailure('missing', path);
      const view = parseFile(cur);
      if (lineNo < 0 || lineNo > view.lines.length) throw new EditFailure('no-match', path);
      const out = [...view.lines];
      out.splice(lineNo, 0, ...add);
      tree.set(path, renderFile({ lines: out, br: view.br, finalBr: view.finalBr }));
    };
  }
  return null;
}

/** The patch is either one JSON array of edit objects, or JSON Lines: one
 *  edit object a line, blank lines ignored. In array form any fault is a
 *  parse fault at the line where the array starts; in JSON Lines form a line
 *  that does not hold one valid edit object is a parse fault at that line. */
function parseJson(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFault(1);
  const edits: EditFn[] = [];
  if (lines[first].trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseFault(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseFault(first + 1);
    for (const x of v) {
      const e = makeJsonEdit(x);
      if (e === null) throw new ParseFault(first + 1);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, idx) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try {
      e = makeJsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseFault(idx + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Order and atomicity (SPEC.md section 10), output (section 2)
// ---------------------------------------------------------------------------

/** The output lines for a run that wrote: one line for each path whose state
 *  changed, in byte order of the paths (UTF-8). A file moved by a move edit
 *  that succeeded is one `R <old> -> <new>` line, sorted by `<new>`, when
 *  `<old>` existed before the patch and does not after it, and `<new>` did
 *  not exist before it and does after it; it replaces that pair's `D` and
 *  `A` lines. */
function outputRows(tree: Tree, moves: [string, string][]): string[] {
  const changed = new Map<string, { before: string | null; after: string | null }>();
  for (const p of tree.touched()) {
    const before = tree.before(p);
    const after = tree.after(p);
    if (before !== after) changed.set(p, { before, after });
  }
  const rows: { key: string; text: string }[] = [];
  const used = new Set<string>();
  for (const [oldP, newP] of moves) {
    const o = changed.get(oldP);
    const n = changed.get(newP);
    if (
      o !== undefined &&
      o.before !== null &&
      o.after === null &&
      n !== undefined &&
      n.before === null &&
      n.after !== null
    ) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      used.add(oldP);
      used.add(newP);
    }
  }
  for (const [p, c] of changed) {
    if (used.has(p)) continue;
    const tag = c.before === null ? 'A' : c.after === null ? 'D' : 'M';
    rows.push({ key: p, text: `${tag} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  return rows.map((r) => r.text);
}

/** Write every change to disk: directories are created as files need them. */
function writeChanges(tree: Tree): void {
  for (const p of tree.touched()) {
    const before = tree.before(p);
    const after = tree.after(p);
    if (before === after) continue;
    if (after === null) {
      rmSync(p, { force: true });
    } else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, after);
    }
  }
}

function run(argv: string[]): { code: number; out: string[] } {
  const cli = parseArgs(argv);
  if (cli === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  const patchFile = cli.patch === null || cli.patch === '-' ? null : cli.patch;
  try {
    text = readFileSync(patchFile ?? 0, 'utf8');
  } catch {
    if (patchFile !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatchLines(text);
  const kind = cli.format === 'auto' ? detectFormat(lines) : cli.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'unified') edits = parseUnified(lines).map((s) => makeUnifiedEdit(s, cli.strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, cli.strict);
    else if (kind === 'v4a') edits = parseV4a(lines, cli.strict);
    else edits = parseJson(text, lines);
  } catch (e) {
    if (e instanceof ParseFault) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }
  if (edits.length === 0) return { code: 2, out: ['error: parse 1'] };
  const tree = new Tree();
  const moves: [string, string][] = [];
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const snapshot = tree.snapshot();
    const movesLen = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFailure)) throw e;
      tree.restore(snapshot);
      moves.length = movesLen;
      failures.push(e);
    }
  }
  if (failures.length > 0) {
    return {
      code: 1,
      out: [...failures.map((f) => `error: ${f.code} ${f.path}`), `failed: ${failures.length} of ${edits.length} edits`],
    };
  }
  const rows = outputRows(tree, moves);
  if (!cli.check) writeChanges(tree);
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
