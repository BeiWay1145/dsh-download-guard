/**
 * Detector unit tests.
 *
 * The negative cases matter at least as much as the positive ones: a guard
 * that blocks ordinary work is worse than no guard, so every rule is paired
 * with the near-miss that must stay allowed.
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { detectInCommand, commandOf, isShellTool, inspect, firstUrl } from '../src/detect.ts'

let checks = 0
function blocks(command) {
  checks += 1
  const hit = detectInCommand(command)
  assert.ok(hit !== undefined, 'expected BLOCK: ' + command)
  return hit
}
function allows(command) {
  checks += 1
  const hit = detectInCommand(command)
  assert.equal(hit, undefined, 'expected ALLOW: ' + command + ' (got ' + JSON.stringify(hit) + ')')
}

// --- curl ---------------------------------------------------------------
blocks('curl -o file.zip https://example.com/f.zip')
blocks('curl -O https://example.com/big.iso')
blocks('curl --output out.bin https://example.com/x')
blocks('curl --output=out.bin https://example.com/x')
allows('curl https://api.example.com/status')            // stdout only
allows('curl -s https://api.example.com/health')          // stdout only
allows('curl -I https://example.com/')                    // headers only

// --- wget ---------------------------------------------------------------
blocks('wget https://example.com/big.tar')
blocks('wget -q https://example.com/big.tar')
allows('wget -O - https://example.com/x')                 // explicit stdout
allows('wget -qO- https://api.example.com/json')          // explicit stdout

// --- PowerShell ---------------------------------------------------------
blocks('Invoke-WebRequest -Uri https://x/f.zip -OutFile f.zip')
blocks('iwr https://example.com/a.iso -OutFile a.iso')
blocks('Invoke-RestMethod https://x/a -OutFile a.json')
blocks('Start-BitsTransfer -Source https://x/big.zip -Destination big.zip')
allows('Invoke-WebRequest -Uri https://api.x/status')     // prints to stdout
allows('Invoke-RestMethod https://api.x/data')            // prints to stdout

// --- a bare filename mention must NEVER block ----------------------------
// The removed download.cjs rule matched the text anywhere in the command, so
// these ordinary commands were denied. They are the regression pin for that
// false positive.
allows("Write-Output 'the old download.cjs channel is gone'")
allows('Get-Content CHANGELOG.md   # mentions download.cjs historically')
allows("echo 'download.cjs'")
allows('Select-String -Pattern "download.cjs" -Path notes.md')

// --- near-misses that must never be blocked -----------------------------
allows('node scripts/build.mjs')
allows('npm install')                                     // out of scope
allows('pip install requests')                            // out of scope
allows('git clone https://github.com/a/b.git')            // git owns its transport
allows('echo hello')
allows('')                                                // empty
allows('Get-Content file.txt')
allows('# a comment mentioning curl -o but not a command')

// --- tool gating --------------------------------------------------------
assert.equal(isShellTool('pwsh'), true)
assert.equal(isShellTool('bash'), true)
assert.equal(isShellTool('read'), false)
checks += 3

// A non-shell tool is never inspected, even with shell-looking args.
assert.equal(inspect('read', { command: 'curl -o x https://y' }), undefined)
// A shell tool with a downloading command is caught.
assert.ok(inspect('pwsh', { command: 'curl -o x https://y' }) !== undefined)
assert.equal(inspect('pwsh', { workdir: '/tmp' }), undefined)
checks += 3

// --- helpers ------------------------------------------------------------
assert.equal(commandOf({ command: 'curl -o x https://y' }), 'curl -o x https://y')
assert.equal(commandOf({}), '')
assert.equal(commandOf(null), '')
assert.equal(firstUrl('curl -o x https://example.com/a.zip'), 'https://example.com/a.zip')
assert.equal(firstUrl('no url here'), undefined)
checks += 5



// fight the JS lexer — the cases ARE about quoting.


// --- issue #1 regressions, loaded from JSON -------------------------------
// These cases are ABOUT quoting (a downstream -o, an escaped quote inside a
// pattern), and embedding them in JS source means fighting the JS lexer for
// no benefit. The fixture keeps them readable and unambiguously quoted.
const fixturePath = new URL('./detect.cases.json', import.meta.url)
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))

for (const c of fixture.mustAllow) {
  checks += 1
  const hit = detectInCommand(c.cmd)
  assert.equal(hit, undefined, 'must ALLOW (' + c.why + '): ' + c.cmd + ' -- got ' + JSON.stringify(hit))
}
console.log('PASS issue#1: ' + fixture.mustAllow.length + ' read-only commands are allowed')

for (const c of fixture.mustBlock) {
  checks += 1
  const hit = detectInCommand(c.cmd)
  assert.ok(hit !== undefined, 'must BLOCK (' + c.why + '): ' + c.cmd)
}
console.log('PASS issue#1: ' + fixture.mustBlock.length + ' real downloads are still blocked')

console.log('PASS detector: ' + checks + ' checks')