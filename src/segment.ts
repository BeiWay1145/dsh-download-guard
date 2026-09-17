/**
 * Shell command segmentation.
 *
 * Detection must judge ONE sub-command at a time. Scanning the whole string
 * for `curl` and `-o` independently (the previous implementation) reported a
 * download whenever both appeared anywhere — so the very common read-only
 * pipeline
 *
 *     curl -s http://host/ | grep -o "field"
 *
 * was denied, even though curl writes only to stdout and the `-o` belongs to
 * the downstream `grep`. Reported as issue #1.
 *
 * The splitter must track quoting, and — the subtle part — must honour
 * BACKSLASH ESCAPES inside double quotes. A tracker that only counts quote
 * characters desynchronises on a command such as
 *
 *     curl -s http://x/ | grep -o "a[^\"']*" | head -5; curl -s http://x/health
 *
 * where the `\"` inside the double-quoted pattern is an escaped quote, not a
 * closing one. Treating it as a close makes the following `|` and `;` appear to
 * be inside a string, so the segments never split and the downstream `grep -o`
 * is attributed to the later curl. This module therefore handles escapes.
 *
 * Scope: this is a SEGMENTER for detection, not a shell parser. It does not
 * expand variables, evaluate substitutions, or handle every POSIX corner. It
 * only has to be conservative in the safe direction: when in doubt it keeps
 * text together, which can at worst produce a missed download (the status quo)
 * rather than a false block (a regression in the user's workflow).
 */

/**
 * Split a shell command into independent sub-commands.
 *
 * Splits on the shell's command separators — `|`, `||`, `&&`, `;`, `&`, and
 * newlines — but only when they appear OUTSIDE quotes. Quoted text is kept
 * verbatim, including its separators, so `grep -o "a|b"` stays one segment.
 *
 * @param command - the raw command string (comment-stripped by the caller).
 * @returns the sub-commands, in order; empty input yields an empty array.
 */
export function splitSubcommands(command: string): string[] {
  const segments: string[] = []
  let current = ''
  // Quote state: none, inside single quotes, or inside double quotes.
  let quote: 'none' | 'single' | 'double' = 'none'

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]

    if (quote === 'single') {
      current += ch
      // Inside single quotes nothing is special except the closing quote;
      // POSIX has no escape mechanism here.
      if (ch === "'") quote = 'none'
      continue
    }

    if (quote === 'double') {
      if (ch === '\\') {
        // Backslash escapes the next character inside double quotes. Consume
        // both so an escaped quote cannot close the string.
        current += ch
        if (i + 1 < command.length) {
          current += command[i + 1]
          i += 1
        }
        continue
      }
      current += ch
      if (ch === '"') quote = 'none'
      continue
    }

    // --- unquoted ---
    if (ch === '\\') {
      // An escaped separator is literal text, not a boundary.
      current += ch
      if (i + 1 < command.length) {
        current += command[i + 1]
        i += 1
      }
      continue
    }
    if (ch === '"') { quote = 'double'; current += ch; continue }
    if (ch === "'") { quote = 'single'; current += ch; continue }

    // Separators. Check the two-character forms before the one-character ones.
    if (ch === '|' || ch === '&') {
      const next = command[i + 1]
      if (next === ch) {
        segments.push(current)
        current = ''
        i += 1
        continue
      }
      segments.push(current)
      current = ''
      continue
    }
    if (ch === ';') {
      segments.push(current)
      current = ''
      continue
    }
    if (ch === '\n' || ch === '\r') {
      segments.push(current)
      current = ''
      continue
    }

    current += ch
  }
  segments.push(current)

  return segments.map((s) => s.trim()).filter((s) => s !== '')
}
