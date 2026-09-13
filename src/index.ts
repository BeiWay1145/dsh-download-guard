/**
 * dsh-download-guard — force every large-file download through aria2.
 *
 * Why this exists: the aria2-download skill states the rule in prose, and
 * prose is advisory. An agent holding a hand-rolled downloader will use it —
 * observed directly, when a 4.76 GB ISO was pulled through
 * dsh-download-progress' download.cjs at 0.13 MB/s while the aria2 engine sat
 * idle (the same file moves at ~12 MB/s through aria2, roughly 90x).
 *
 * This plugin moves the rule from prose into the runtime: it listens on
 * tools/pre-execute and DENIES a shell call that would write bytes to disk,
 * returning a reason that names the aria2 forwarder to use instead.
 *
 * Why tools/pre-execute and not the approval chain: under an approval policy
 * of 'never', ApprovalService.decide() returns 'rejected' BEFORE it dispatches
 * the approval/request waterfall, so an approval listener is never invoked at
 * all. The tools pipeline is a separate waterfall with no such short-circuit,
 * and a 'deny' decision stops dispatch before the tool body runs (verified
 * against the real ToolRuntime, not just against the type definitions).
 *
 * Scope, by decision: large-file downloads only. Package managers (pip, npm)
 * are explicitly out of scope — neither detected nor blocked.
 */
import { inspect } from './detect.ts'

/**
 * The forwarder every blocked download is told to run instead.
 * Uses $env:USERPROFILE because the guard cannot know the absolute home path
 * at build time, and the reader is a PowerShell-capable agent.
 */
const FORWARDER = 'node "$env:USERPROFILE\\.dsh\\skills\\aria2-download\\scripts\\aria2-dl.js"'

/**
 * Build the denial text: what was blocked, why, and the exact replacement
 * command. An agent that gets a bare refusal has to guess the sanctioned
 * path; handing it the command makes compliance the path of least effort,
 * which is the whole point of the plugin.
 */
export function denialMessage(rule: string, url: string | undefined, command: string): string {
  const target = url === undefined ? '<URL>' : url
  const lines = [
    'BLOCKED by dsh-download-guard: this command downloads a file to disk',
    '(matched: ' + rule + '), and downloads must go through the local aria2 engine',
    '(Motrix Next) so they are multithreaded, resumable and visible in the download manager.',
    '',
    'Use instead:',
    '  ' + FORWARDER + ' "' + target + '" --out=<filename>',
    '',
    'Options: --dir=<dir> for the destination, --header="K: V" for headers,',
    '--no-wait to enqueue and return immediately (then query with --status <gid>).',
    'A blocked command is never partially executed.',
  ]
  const shown = command.length > 240 ? command.slice(0, 240) + '...' : command
  lines.push('', 'Blocked command: ' + shown)
  return lines.join('\n')
}

/** Minimal structural views, so the package needs no DSH type dependency. */
interface PreExecuteExec {
  name?: unknown
  arguments?: unknown
}
interface PluginContext {
  on(event: string, listener: (exec: PreExecuteExec, next: () => Promise<unknown>) => Promise<unknown>): () => void
  logger?: { info(msg: string): void; warn(msg: string): void }
}

/**
 * Register the guard.
 * @param ctx - the cordis context; only the event bus is required.
 */
export function apply(ctx: PluginContext): void {
  ctx.on('tools/pre-execute', async (exec, next) => {
    let hit: ReturnType<typeof inspect>
    try {
      const name = typeof exec?.name === 'string' ? exec.name : ''
      hit = inspect(name, exec?.arguments)
    } catch {
      // A detector bug must never block an unrelated tool call.
      return next()
    }
    if (hit === undefined) return next()

    const args = exec?.arguments as { command?: unknown } | undefined
    const command = typeof args?.command === 'string' ? args.command : ''
    const reason = denialMessage(hit.rule, hit.url, command)
    try {
      ctx.logger?.info('download-guard: blocked ' + hit.rule + (hit.url === undefined ? '' : ' (' + hit.url + ')'))
    } catch {
      /* logging must never affect the decision */
    }
    return { kind: 'deny', reason }
  })
}
