# dsh-download-guard

Turns "downloads must go through aria2" from **advice in a skill** into **runtime enforcement**.

## Why

The `aria2-download` skill states the rule in its prompt, and **a prompt is only advice**. What actually happened:

| | aria2 channel | Bypass channel |
|---|---|---|
| Engine | aria2-next (Motrix Next) | single-connection node https |
| Measured speed | **11.78 MB/s** | **0.13 MB/s** |
| Visible in Motrix | ✅ | ❌ |
| Resumable | ✅ | partial |

The same 4.76 GB Windows 11 image, roughly **90x apart**. And an agent holding a `download.cjs` will use it, because **at the shell level `node download.cjs` and `aria2-dl.js` look identical** — nothing distinguishes them.

This plugin moves the rule into the runtime: **intercept the tool call, deny it, and hand back the correct aria2 command**.

## How it works

It listens on cordis' `tools/pre-execute` hook (waterfall mode) and rules **before the tool body ever runs**:

```
model requests pwsh("curl -o x.iso https://...")
    ↓
tools/pre-execute fires
    ↓
recognised as a download → { kind: 'deny', reason: '<ready-to-run aria2 command>' }
    ↓
the call is refused and the reason is shown to the model (the body never ran)
```

### Why not the approval hook

The `approval/request` waterfall is **dead under an approval policy of `never`** — `ApprovalService.decide()` returns before it is ever dispatched:

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // returns here
const answer = ... this.ctx.waterfall(..., "approval/request", ...)   // never reached
```

`tools/pre-execute` is a **separate waterfall with no such short-circuit**, so it works under every policy.

## What is blocked

The criterion comes from the skill itself: **whether bytes are being written to disk** — not what the URL looks like or how large the file is.

| Blocked | Allowed |
|---|---|
| `curl -o F` / `curl -O` / `curl --output F` | `curl https://api.x/status` (stdout only) |
| `wget <url>` (writes a file by default) | `wget -O - <url>` (explicit stdout) |
| `Invoke-WebRequest ... -OutFile F` | `Invoke-WebRequest https://api.x/status` |
| `Invoke-RestMethod ... -OutFile F` | `Invoke-RestMethod https://api.x/data` |
| `Start-BitsTransfer ...` | — |
| `node .../download.cjs` | — |

**Deliberately not blocked** (by design):

- `pip install` / `npm install` and other package managers — out of scope for this plugin
- `git clone` — git owns its own transport
- commented-out commands (a shell never runs them)
- non-shell tools (even when their arguments contain `curl -o`)

Detection is **biased toward false negatives**: blocking an ordinary command is a visible regression, while missing a download is merely the status quo.

## What the model sees when blocked

```
BLOCKED by dsh-download-guard: this command downloads a file to disk
(matched: curl-output), and downloads must go through the local aria2 engine
(Motrix Next) so they are multithreaded, resumable and visible in the download manager.

Use instead:
  node "$env:USERPROFILE\.dsh\skills\aria2-download\scripts\aria2-dl.js" "<URL>" --out=<filename>

Options: --dir=<dir> for the destination, --header="K: V" for headers,
--no-wait to enqueue and return immediately (then query with --status <gid>).
A blocked command is never partially executed.

Blocked command: curl -o Win11.iso https://.../y.iso
```

The **URL is extracted and substituted into the suggested command** — whoever was refused does not have to guess how to comply.

## Install

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add "dsh-download-guard@github:BeiWay1145/dsh-download-guard"
```

**Restart DSH** afterwards.

## Known limits

- **Cannot catch a download that happens INSIDE a command**: a `python script.py` using `urllib` looks like `python script.py` from here. Fully closing that needs a proxy layer, which is out of scope.
- **Cannot catch downloads outside DSH**: a `curl -o` in an unrelated terminal is unaffected.
- Requires the host's `tools/pre-execute` hook (verified on the DSH 0.1.5-rc series).

## Development

```bash
npm install
npm test          # build + detector unit tests + real-ToolRuntime runtime test
npm run typecheck
```

Two test layers:

- `tests/detect.test.mjs` — the pure detection rules (38 checks, heavy on must-stay-allowed near-misses)
- `tests/guard.runtime.mjs` — loads the **built artifact** into a real cordis + ToolRuntime and proves a deny really stops the tool body

The runtime test locates an installed DSH tree itself and **skips rather than fails** when none is present, so a bare checkout still passes.

## License

MIT
