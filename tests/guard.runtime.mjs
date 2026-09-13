/**
 * Runtime guard test: loads the BUILT plugin into a real cordis Context with
 * the real ToolRuntime, then dispatches tool calls and asserts the guard's
 * effect on each one.
 *
 * This is the layer the detector unit tests cannot reach: whether the plugin
 * actually registers, whether a deny really stops the tool body, and whether
 * an allowed command still reaches it.
 *
 * WHY THE DYNAMIC RESOLUTION: cordis and dsh-tools are host packages, not
 * dependencies of this plugin, so they are absent from node_modules here. The
 * test resolves them from an installed DSH tree instead, and SKIPS (exit 0)
 * when none is found — a bare checkout must not fail on a missing host.
 */
import { strict as assert } from 'node:assert'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** Find a directory where @deepseek-ai/cordis and @deepseek-ai/dsh-tools resolve. */
function findHostModules() {
  const candidates = []
  // A store directory that also holds dsh-tools is the reliable shape:
  // pnpm symlinks every sibling dependency next to it.
  const stores = []
  const dshHome = join(homedir(), '.dsh')
  for (const entry of safeReaddir(dshHome)) {
    const pnpm = join(dshHome, entry, 'node_modules', '.pnpm')
    if (existsSync(pnpm)) stores.push(pnpm)
  }
  for (const store of stores) {
    for (const dir of safeReaddir(store)) {
      if (!dir.startsWith('@deepseek-ai+dsh-tools@')) continue
      const nm = join(store, dir, 'node_modules')
      if (existsSync(join(nm, '@deepseek-ai', 'dsh-tools'))) candidates.push(nm)
    }
  }
  return candidates
}

function safeReaddir(p) {
  try { return readdirSync(p) } catch { return [] }
}

const hosts = findHostModules()
if (hosts.length === 0) {
  console.log('SKIP runtime guard test: no installed DSH tree with dsh-tools found.')
  console.log('     (run this in a checkout of a machine that has DSH installed)')
  process.exit(0)
}
const host = hosts[0]
const load = (pkg) => import(pathToFileURL(join(host, '@deepseek-ai', pkg, 'lib', 'index.js')).href)

const { Context, Service } = await load('cordis')
const { ToolRuntime, defineTool } = await load('dsh-tools')

// ToolRuntime wires tool schemas onto systemPrompt at construction; only that
// service is stubbed, since it is irrelevant to the gate under test.
class FakeSystemPrompt extends Service {
  constructor(ctx) { super(ctx, 'systemPrompt') }
  tools(_cb) { return () => {} }
  context(_cb) { return () => {} }
}

let bodyRuns = []
const shellTool = defineTool({
  name: 'pwsh',
  description: 'fake shell',
  parameters: { command: { type: 'string', description: 'cmd' } },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  },
  async execute(args) { bodyRuns.push(args.command); return { ok: true } },
})
const readTool = defineTool({
  name: 'read',
  description: 'fake read',
  parameters: { command: { type: 'string', description: 'path' } },
  output: {
    schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
    render: (_a, v) => [{ type: 'text', text: JSON.stringify(v) }],
  },
  async execute(args) { bodyRuns.push('READ:' + args.command); return { ok: true } },
})

const ctx = new Context()
new FakeSystemPrompt(ctx)
const runtime = new ToolRuntime(ctx, { mode: 'native' })
runtime.register(shellTool)
runtime.register(readTool)

const guardUrl = pathToFileURL(new URL('../lib/index.js', import.meta.url).pathname.replace(/^\//, '')).href
const guard = await import(guardUrl)
assert.equal(typeof guard.apply, 'function', 'plugin exports apply')
guard.apply(ctx)
console.log('PASS built plugin loaded and applied')

async function dispatch(name, command) {
  const signal = new AbortController().signal
  return runtime.execute({ name, arguments: { command }, signal })
}

// --- a download is blocked BEFORE the body runs -------------------------
bodyRuns = []
const blocked = await dispatch('pwsh', 'curl -o model.bin https://example.com/model.bin')
assert.equal(blocked.isError, true, 'download is reported as an error')
assert.equal(bodyRuns.length, 0, 'the tool body never ran')
const text = blocked.content.map((c) => c.text).join('')
assert.ok(text.includes('BLOCKED by dsh-download-guard'), 'reason reaches the model')
assert.ok(text.includes('aria2-dl.js'), 'reason names the aria2 forwarder')
assert.ok(text.includes('https://example.com/model.bin'), 'reason echoes the URL')
console.log('PASS blocked: curl -o denied, body skipped, aria2 command supplied')

// --- a filename mention reaches the body (removed rule regression) ------
// The deleted download.cjs rule denied any command containing that text.
// This pins that the denial is gone end to end, not just in the detector.
bodyRuns = []
const mention = await dispatch('pwsh', "Write-Output 'download.cjs was removed'")
assert.notEqual(mention.isError, true, 'a filename mention must not be denied')
assert.equal(bodyRuns.length, 1, 'the body ran for a filename mention')
console.log('PASS allowed: a bare download.cjs mention is no longer denied')

// --- ordinary work passes ----------------------------------------------
for (const ok of [
  'curl https://api.example.com/status',
  'npm install',
  'pip install requests',
  'git clone https://github.com/a/b.git',
  'Get-Content notes.md',
]) {
  bodyRuns = []
  const res = await dispatch('pwsh', ok)
  assert.notEqual(res.isError, true, 'must pass: ' + ok)
  assert.deepEqual(bodyRuns, [ok], 'body ran for: ' + ok)
}
console.log('PASS allowed: 5 ordinary commands reached the tool body')

// --- a non-shell tool is never inspected -------------------------------
bodyRuns = []
const readRes = await dispatch('read', 'curl -o x https://y')
assert.notEqual(readRes.isError, true, 'read is not gated')
assert.deepEqual(bodyRuns, ['READ:curl -o x https://y'], 'read body ran')
console.log('PASS scoped: the guard only judges shell tools')

console.log('')
console.log('All runtime guard tests passed.')
