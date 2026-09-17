/**
 * Download-command detection.
 *
 * A pure function over one tool call's name + arguments, kept free of any
 * cordis/DSH import so it can be unit-tested directly and reasoned about
 * without a runtime.
 *
 * The governing rule, taken from the aria2-download skill: the criterion is
 * WHETHER BYTES ARE BEING WRITTEN TO DISK, not whether the URL ends in .json
 * or how large the target is. So a curl that prints an API response to stdout
 * is ordinary work and MUST pass; a curl -o is a download and must be
 * redirected to aria2.
 *
 * Detection is PER SUB-COMMAND, not over the whole string. Scanning the raw
 * string for `curl` and `-o` independently reported a download whenever both
 * appeared anywhere, so a read-only pipeline such as
 *
 *     curl -s http://host/ | grep -o "field"
 *
 * was denied even though curl writes only to stdout and `-o` belongs to grep
 * (issue #1). Every rule below therefore runs against one segment produced by
 * {@link splitSubcommands}.
 *
 * Deliberately NOT detected:
 * - curl/wget without an output flag (stdout only) — the common case for
 *   reading a page or an API response.
 * - wget -O - / curl -o - (explicit stdout) — same reasoning.
 * - curl -o /dev/null (and NUL on Windows) — a black-hole target leaves no
 *   file, so it is a read, not a download.
 * - Package managers (pip install, npm install) — out of scope by decision:
 *   this guard covers large-file downloads only.
 * - bare filename mentions such as "download.cjs" — removed as a rule after it
 *   false-positived on ordinary commands that merely referenced the text.
 */
import { splitSubcommands } from './segment.ts'

/** A detection result: which pattern matched, and the URL when one is visible. */
export interface DownloadHit {
  /** Short machine name of the matched pattern (for tests and messages). */
  rule: string
  /** The URL the command appears to fetch, when one could be extracted. */
  url?: string
}

/** Shell tools whose command string is worth inspecting. */
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell'])

/** Extract the command string from a tool call's arguments. */
export function commandOf(args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const command = (args as { command?: unknown }).command
  return typeof command === 'string' ? command : ''
}

/**
 * Whether a shell command downloads a file to disk.
 *
 * Detection is intentionally biased toward FALSE NEGATIVES on ambiguous
 * input: blocking an ordinary command is a visible regression in the user's
 * workflow, while missing one download is the status quo this plugin exists
 * to improve on. Every rule therefore requires a WRITE signal, never merely a
 * fetch verb.
 */
export function detectInCommand(command: string): DownloadHit | undefined {
  if (command === '') return undefined

  // Strip comments and here-string bodies first: a shell never executes a
  // commented-out command, so a `curl -o` in a comment is not a download.
  // PowerShell uses '#', POSIX shells the same; both are line-oriented here.
  const code = stripComments(command)
  if (code === '') return undefined

  // NOTE: a `download.cjs` rule lived here and was REMOVED.
  //
  // It matched the bare filename anywhere in the command, with no anchor on an
  // interpreter or argument position, so any occurrence of that text — inside a
  // quoted string, a log message, a comment being echoed — was denied. That was
  // observed in practice: an ordinary read-only command whose output happened
  // to mention the filename was blocked.
  //
  // It is also moot now: the plugin that shipped the downloader was
  // uninstalled and its script deleted, so the rule had no remaining target
  // while carrying the highest false-positive risk of any rule here. The
  // write-to-disk rules below cover the real cases.

  // Judge each sub-command on its own. A hit in any one of them is a download.
  // Attributing an output flag to the right command is the whole point: the
  // previous whole-string scan let a downstream `grep -o` condemn a curl.
  for (const segment of splitSubcommands(code)) {
    const hit = detectInSegment(segment)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Targets that accept the bytes without keeping a file, so no download occurs. */
const NULL_TARGETS = new Set(['-', '/dev/null', '/dev/stdout', '/dev/stderr', 'nul', '$null'])

/** Strip surrounding quotes from an argument. */
function unquote(s: string): string {
  const t = s.trim()
  if (t.length >= 2) {
    const first = t[0]
    const last = t[t.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return t.slice(1, -1)
    }
  }
  return t
}

/**
 * Whether a curl invocation writes a file.
 *
 * True for `-o FILE`, `--output FILE`/`--output=FILE`, `-O` and
 * `--remote-name`/`--remote-name-all`.
 *
 * False when the destination is a stdout marker or a black hole — `-o -`,
 * `-o /dev/null`, `-o NUL` — because those keep no file. Without this
 * exception `curl -s -o - URL | head` and `curl -o /dev/null -w '%{http_code}'`
 * would be denied even though they write nothing.
 *
 * `--output-dir` alone is deliberately NOT a write signal: it only names a
 * directory, and curl still needs `-o`/`-O` to write anything.
 */
function curlWritesFile(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t !== '')
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    // --- -O / --remote-name: always writes, named after the remote file ---
    if (tok === '-O' || tok === '--remote-name' || tok === '--remote-name-all') return true
    // Bundled short flags such as -sO or -LO also write.
    if (/^-[A-Za-z]*O[A-Za-z]*$/.test(tok)) return true
    // --- --output=FILE ---
    if (tok.startsWith('--output=')) {
      return !NULL_TARGETS.has(unquote(tok.slice('--output='.length)).toLowerCase())
    }
    // --- --output FILE ---
    if (tok === '--output') {
      const next = tokens[i + 1]
      if (next === undefined) return true // malformed; curl will complain
      return !NULL_TARGETS.has(unquote(next).toLowerCase())
    }
    // --- -o FILE (exact token) ---
    if (tok === '-o') {
      const next = tokens[i + 1]
      if (next === undefined) return true
      return !NULL_TARGETS.has(unquote(next).toLowerCase())
    }
    // --- -oFILE (glued form) ---
    if (/^-o./.test(tok)) {
      return !NULL_TARGETS.has(unquote(tok.slice(2)).toLowerCase())
    }
  }
  return false
}

/**
 * Whether a wget invocation sends its payload to stdout instead of a file.
 *
 * wget writes a file by DEFAULT, so this looks for the exception: `-O -` (or
 * `--output-document=-`), which is the documented way to stream to stdout.
 * The flag may be bundled with other short flags (-qO-, -nvO-) and the target
 * may be quoted.
 */
function wgetWritesStdout(segment: string): boolean {
  const tokens = segment.split(/\s+/).filter((t) => t !== '')
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (tok === '--output-document=-') return true
    if (tok === '--output-document') {
      const next = tokens[i + 1]
      if (next !== undefined && unquote(next) === '-') return true
      continue
    }
    // -O <target>, possibly bundled with other short flags.
    if (/^-[A-Za-z]*O$/.test(tok)) {
      const next = tokens[i + 1]
      if (next !== undefined && unquote(next) === '-') return true
      continue
    }
    // -O- glued form.
    if (/^-[A-Za-z]*O-$/.test(tok)) return true
  }
  return false
}

/**
 * Whether one sub-command writes bytes to disk.
 * @param segment - a single sub-command (no separators).
 * @returns a hit when it downloads, else undefined.
 */
function detectInSegment(segment: string): DownloadHit | undefined {
  // --- curl -------------------------------------------------------------
  if (/\bcurl\b/.test(segment) && curlWritesFile(segment)) {
    return { rule: 'curl-output', url: firstUrl(segment) }
  }

  // --- wget -------------------------------------------------------------
  if (/\bwget\b/.test(segment) && !wgetWritesStdout(segment)) {
    return { rule: 'wget', url: firstUrl(segment) }
  }

  // --- PowerShell -------------------------------------------------------
  if (/\b(Invoke-WebRequest|iwr)\b/.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: 'Invoke-WebRequest', url: firstUrl(segment) }
  }
  if (/\bInvoke-RestMethod\b/i.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: 'Invoke-RestMethod', url: firstUrl(segment) }
  }
  if (/\bStart-BitsTransfer\b/i.test(segment)) {
    return { rule: 'Start-BitsTransfer', url: firstUrl(segment) }
  }

  return undefined
}

/**
 * Remove comment lines. Line-oriented and deliberately shallow: it only needs
 * to keep a commented-out command from tripping the detector, not to parse a
 * shell. A '#' inside a quoted string is left alone by checking that no quote
 * precedes it on the same line.
 */
export function stripComments(command: string): string {
  return command
    .split(/\r?\n/)
    .map((line) => {
      const hash = line.indexOf('#')
      if (hash < 0) return line
      // Only treat it as a comment when it starts the line or follows
      // whitespace, and no quote opened before it on this line.
      const before = line.slice(0, hash)
      const quotes = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length
      if (quotes % 2 === 1) return line
      if (before.trim() === '') return ''
      if (/\s$/.test(before)) return before
      return line
    })
    .join('\n')
    .trim()
}

/** Whether this tool call is a shell call this plugin inspects at all. */
export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.has(name)
}

/** Best-effort first http(s) URL in a command string. */
export function firstUrl(command: string): string | undefined {
  const m = /https?:\/\/[^\s'"`)]+/.exec(command)
  return m === null ? undefined : m[0]
}

/**
 * The full decision for one tool call.
 * @returns a hit when the call must be blocked, else undefined.
 */
export function inspect(name: string, args: unknown): DownloadHit | undefined {
  if (!isShellTool(name)) return undefined
  return detectInCommand(commandOf(args))
}