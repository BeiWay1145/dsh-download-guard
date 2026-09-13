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
 * Deliberately NOT detected:
 * - curl/wget without an output flag (stdout only) — the common case for
 *   reading a page or an API response.
 * - wget -O - (explicit stdout) — same reasoning.
 * - Package managers (pip install, npm install) — out of scope by decision:
 *   this guard covers large-file downloads only.
 * - bare filename mentions such as "download.cjs" — removed as a rule after it
 *   false-positived on ordinary commands that merely referenced the text.
 */

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

  // --- curl -------------------------------------------------------------
  // Requires an explicit output flag: -o FILE | -O | --output FILE
  if (/\bcurl\b/.test(code)) {
    if (/(^|\s)(-o|-O|--output)(\s|=|$)/.test(code)) {
      return { rule: 'curl-output', url: firstUrl(code) }
    }
    // A bare curl writes to stdout only — allowed.
  }

  // --- wget -------------------------------------------------------------
  if (/\bwget\b/.test(code)) {
    // -O - means stdout explicitly. The flag may be bundled with other short
    // flags (-qO-, -nvO-) or separated (-O -), and the target may be quoted.
    // Any of those forms must stay allowed: it is an ordinary stdout read.
    const writesStdout =
      /(^|\s)-[A-Za-z]*O\s*['"]?-['"]?(\s|$)/.test(code) ||
      /(^|\s)--output-document[=\s]+['"]?-[\'"]?(\s|$)/.test(code)
    if (!writesStdout) return { rule: 'wget', url: firstUrl(code) }
  }

  // --- PowerShell -------------------------------------------------------
  if (/\b(Invoke-WebRequest|iwr)\b/.test(code) && /-OutFile(\s|$|:)/i.test(code)) {
    return { rule: 'Invoke-WebRequest', url: firstUrl(code) }
  }
  if (/\bInvoke-RestMethod\b/i.test(code) && /-OutFile(\s|$|:)/i.test(code)) {
    return { rule: 'Invoke-RestMethod', url: firstUrl(code) }
  }
  if (/\bStart-BitsTransfer\b/i.test(code)) {
    return { rule: 'Start-BitsTransfer', url: firstUrl(code) }
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
