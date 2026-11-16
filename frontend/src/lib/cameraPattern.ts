/**
 * Pattern engine for the camera file-name playground (Settings -> Cameras,
 * WEB-SET-CAMERAS-070..084).
 *
 * Two kinds of function live here:
 *  - cheap and safe on the page thread: `tokenize`, `validatePattern`
 *    (constructing a RegExp does not backtrack), `parseMatch`, `fmtTs`;
 *  - `runJob`, which EXECUTES a user pattern. It MUST run only inside
 *    `cameraPattern.worker.ts` under a wall-clock limit (WEB-SET-CAMERAS-081).
 *
 * The server stays the final judge: saving a profile always goes through its
 * validation and unsafe-regex check.
 */

export const MAX_PATTERN = 500;
export const MAX_FILENAME = 1024;
export const MAX_OWN_NAMES = 10;
export const MAX_PROFILES = 20;
export const MAX_VIEWS = 16;
export const REQUIRED_GROUPS = ['camera', 'ts', 'ext'] as const;
export const PREVIEW_DEBOUNCE_MS = 300;
export const PREVIEW_LIMIT_MS = 500;

/** The five built-in example names (WEB-SET-CAMERAS-077). */
export const EXAMPLE_FILENAMES: readonly string[] = [
  'Front_00_20240115143022.mp4',
  'Front_01_20240115143022.mp4',
  'Webcam_G12345_20240115143022.mp4',
  'Parking_2024-01-15_14-30-22.mp4',
  'MDAlarm_20240115-143022.mp4',
];

/** Starter pattern of a new profile: all four groups. */
export const STARTER_PATTERN =
  '^(?<camera>[A-Za-z0-9]+)_(?<view>\\d{2})_(?<ts>\\d{14})\\.(?<ext>mp4)$';

export type GroupClass = 'camera' | 'view' | 'ts' | 'ext' | 'other';

export function groupClass(name: string): GroupClass {
  switch (name) {
    case 'camera': return 'camera';
    case 'view':
    case 'lens': return 'view';
    case 'ts': return 'ts';
    case 'ext': return 'ext';
    default: return 'other';
  }
}

/* ───────────────────────── syntax colouring ───────────────────────── */

export interface Tok {
  text: string;
  /** Space-separated CSS class suffixes, see PatternPlayground.css. */
  cls: string;
}

/**
 * Split a pattern into coloured tokens. Pure string scan: it never executes
 * the pattern. The concatenation of all `text` values equals the input.
 */
export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const stack: string[] = [];
  let inClass = false;
  let i = 0;
  const cur = () => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k]) return stack[k];
    return '';
  };
  const push = (text: string, cls: string) => out.push({ text, cls: cls.trim() });
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      push(src.slice(i, i + 2), `esc ${cur()}`);
      i += 2;
      continue;
    }
    if (inClass) {
      push(ch, `cls ${cur()}`);
      if (ch === ']') inClass = false;
      i++;
      continue;
    }
    if (ch === '[') {
      inClass = true;
      push(ch, `cls ${cur()}`);
      i++;
      continue;
    }
    if (ch === '(') {
      const rest = src.slice(i);
      const named = /^\(\?<([A-Za-z_]\w*)>/.exec(rest);
      if (named) {
        const g = groupClass(named[1]);
        stack.push(g);
        push(named[0], `open ${g}`);
        i += named[0].length;
        continue;
      }
      const nc = /^\(\?(?::|=|!|<=|<!)/.exec(rest);
      stack.push('');
      push(nc ? nc[0] : '(', `par ${cur()}`);
      i += nc ? nc[0].length : 1;
      continue;
    }
    if (ch === ')') {
      const g = cur();
      stack.pop();
      push(ch, g ? `open ${g}` : 'par');
      i++;
      continue;
    }
    if (ch === '^' || ch === '$') {
      push(ch, 'anc');
      i++;
      continue;
    }
    if (ch === '+' || ch === '*' || ch === '?' || ch === '|') {
      push(ch, `q ${cur()}`);
      i++;
      continue;
    }
    if (ch === '{') {
      const m = /^\{\d+(?:,\d*)?\}/.exec(src.slice(i));
      if (m) {
        push(m[0], `q ${cur()}`);
        i += m[0].length;
        continue;
      }
    }
    push(ch, `lit ${cur()}`);
    i++;
  }
  return out;
}

/** Names of the named groups in the pattern, in order. Escapes and classes are skipped. */
export function namedGroups(src: string): string[] {
  const names: string[] = [];
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (inClass) { if (ch === ']') inClass = false; continue; }
    if (ch === '[') { inClass = true; continue; }
    if (ch === '(') {
      const m = /^\(\?<([A-Za-z_]\w*)>/.exec(src.slice(i));
      if (m) names.push(m[1]);
    }
  }
  return names;
}

/* ───────────────────────── validation (page thread) ───────────────────────── */

export type PatternErrorKind = 'empty' | 'tooLong' | 'syntax' | 'groups';

export interface PatternCheck {
  groups: string[];
  missing: string[];
  error: null | { kind: PatternErrorKind; detail?: string };
}

/**
 * Cheap static checks. Constructing a RegExp parses but does not run it, so
 * this is safe on the page thread. "Too slow" is decided separately, by the
 * worker timeout (WEB-SET-CAMERAS-081).
 */
export function validatePattern(src: string): PatternCheck {
  const groups = namedGroups(src);
  const missing = REQUIRED_GROUPS.filter(g => !groups.includes(g));
  if (!src.trim()) return { groups, missing, error: { kind: 'empty' } };
  if (src.length > MAX_PATTERN) return { groups, missing, error: { kind: 'tooLong' } };
  try {
    new RegExp(src, 'i');
  } catch (e) {
    const detail = (e instanceof Error ? e.message : String(e))
      .replace(/^Invalid regular expression: /, '')
      .replace(/^\/.*\/[a-z]*: /, '');
    return { groups, missing, error: { kind: 'syntax', detail } };
  }
  if (missing.length > 0) return { groups, missing, error: { kind: 'groups' } };
  return { groups, missing, error: null };
}

/* ───────────────────────── execution (worker only) ───────────────────────── */

export type NoMatchReason =
  | 'tooLong'
  | 'partial'
  | 'fewDigits'
  | 'extension'
  | 'tsDigits'
  | 'generic';

export interface Span { group: string; start: number; end: number }

export interface MatchJob { key: string; source: string; name: string }

export type JobResult =
  | { key: string; status: 'error' }
  | { key: string; status: 'nomatch'; reason: NoMatchReason }
  | { key: string; status: 'match'; groups: Record<string, string>; spans: Span[] };

function whyNot(source: string, name: string): NoMatchReason {
  if (name.length > MAX_FILENAME) return 'tooLong';
  try {
    const loose = new RegExp(source.replace(/^\^/, '').replace(/\$$/, ''), 'i');
    if (loose.test(name)) return 'partial';
  } catch { /* the pattern is checked elsewhere */ }
  const digits = (name.match(/\d/g) ?? []).length;
  if (digits < 14) return 'fewDigits';
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1];
  if (ext && !source.toLowerCase().includes(ext.toLowerCase())) return 'extension';
  return 'generic';
}

/**
 * Run one pattern against one name, case-insensitively, like ingest.
 * DANGEROUS on the page thread: a catastrophic pattern never returns.
 */
export function runJob(job: MatchJob): JobResult {
  const { key, source, name } = job;
  if (name.length > MAX_FILENAME) return { key, status: 'nomatch', reason: 'tooLong' };
  let re: RegExp;
  try {
    re = new RegExp(source, 'id');
  } catch {
    try {
      re = new RegExp(source, 'i'); // engine without the `d` flag: no spans
    } catch {
      return { key, status: 'error' };
    }
  }
  const m = re.exec(name);
  if (!m) return { key, status: 'nomatch', reason: whyNot(source, name) };
  const groups: Record<string, string> = {};
  for (const [g, v] of Object.entries(m.groups ?? {})) if (typeof v === 'string') groups[g] = v;
  const tsDigits = (groups.ts ?? '').replace(/\D/g, '');
  if (!groups.camera || !groups.ts || !groups.ext || tsDigits.length !== 14) {
    return { key, status: 'nomatch', reason: 'tsDigits' };
  }
  const spans: Span[] = [];
  for (const [g, r] of Object.entries(m.indices?.groups ?? {})) {
    if (r) spans.push({ group: g, start: r[0], end: r[1] });
  }
  return { key, status: 'match', groups, spans };
}

/* ───────────────────────── presentation (page thread) ───────────────────────── */

export interface Segment { text: string; group: string | null }

/** Cut `name` into runs owned by one group (the innermost, i.e. shortest, group wins). */
export function segments(name: string, spans: Span[]): Segment[] {
  const owner: (string | null)[] = new Array(name.length).fill(null);
  const ordered = [...spans].sort((a, b) => (b.end - b.start) - (a.end - a.start));
  for (const s of ordered) for (let i = s.start; i < s.end && i < name.length; i++) owner[i] = s.group;
  const out: Segment[] = [];
  for (let i = 0; i < name.length; i++) {
    const last = out[out.length - 1];
    if (last && last.group === owner[i]) last.text += name[i];
    else out.push({ text: name[i], group: owner[i] });
  }
  return out;
}

export interface ParsedMatch {
  camera: string;
  /** `view` group, else `lens` group, else null (caller falls back to the first view row). */
  view: string | null;
  ts: string;
  ext: string;
  segs: Segment[];
}

export function parseMatch(name: string, r: Extract<JobResult, { status: 'match' }>): ParsedMatch {
  return {
    camera: r.groups.camera ?? '',
    view: r.groups.view ?? r.groups.lens ?? null,
    ts: (r.groups.ts ?? '').replace(/\D/g, ''),
    ext: r.groups.ext ?? '',
    segs: segments(name, r.spans),
  };
}

/** `20240115143022` -> a locale date and time. */
export function fmtTs(d14: string): string {
  const d = new Date(
    Number(d14.slice(0, 4)), Number(d14.slice(4, 6)) - 1, Number(d14.slice(6, 8)),
    Number(d14.slice(8, 10)), Number(d14.slice(10, 12)), Number(d14.slice(12, 14)),
  );
  return isNaN(d.getTime()) ? d14 : d.toLocaleString();
}
