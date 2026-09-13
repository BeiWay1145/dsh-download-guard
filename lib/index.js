// src/detect.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["pwsh", "bash", "shell"]);
function commandOf(args) {
  if (args === null || typeof args !== "object") return "";
  const command = args.command;
  return typeof command === "string" ? command : "";
}
function detectInCommand(command) {
  if (command === "") return void 0;
  const code = stripComments(command);
  if (code === "") return void 0;
  if (/\bcurl\b/.test(code)) {
    if (/(^|\s)(-o|-O|--output)(\s|=|$)/.test(code)) {
      return { rule: "curl-output", url: firstUrl(code) };
    }
  }
  if (/\bwget\b/.test(code)) {
    const writesStdout = /(^|\s)-[A-Za-z]*O\s*['"]?-['"]?(\s|$)/.test(code) || /(^|\s)--output-document[=\s]+['"]?-[\'"]?(\s|$)/.test(code);
    if (!writesStdout) return { rule: "wget", url: firstUrl(code) };
  }
  if (/\b(Invoke-WebRequest|iwr)\b/.test(code) && /-OutFile(\s|$|:)/i.test(code)) {
    return { rule: "Invoke-WebRequest", url: firstUrl(code) };
  }
  if (/\bInvoke-RestMethod\b/i.test(code) && /-OutFile(\s|$|:)/i.test(code)) {
    return { rule: "Invoke-RestMethod", url: firstUrl(code) };
  }
  if (/\bStart-BitsTransfer\b/i.test(code)) {
    return { rule: "Start-BitsTransfer", url: firstUrl(code) };
  }
  return void 0;
}
function stripComments(command) {
  return command.split(/\r?\n/).map((line) => {
    const hash = line.indexOf("#");
    if (hash < 0) return line;
    const before = line.slice(0, hash);
    const quotes = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length;
    if (quotes % 2 === 1) return line;
    if (before.trim() === "") return "";
    if (/\s$/.test(before)) return before;
    return line;
  }).join("\n").trim();
}
function isShellTool(name) {
  return SHELL_TOOLS.has(name);
}
function firstUrl(command) {
  const m = /https?:\/\/[^\s'"`)]+/.exec(command);
  return m === null ? void 0 : m[0];
}
function inspect(name, args) {
  if (!isShellTool(name)) return void 0;
  return detectInCommand(commandOf(args));
}

// src/index.ts
var FORWARDER = 'node "$env:USERPROFILE\\.dsh\\skills\\aria2-download\\scripts\\aria2-dl.js"';
function denialMessage(rule, url, command) {
  const target = url === void 0 ? "<URL>" : url;
  const lines = [
    "BLOCKED by dsh-download-guard: this command downloads a file to disk",
    "(matched: " + rule + "), and downloads must go through the local aria2 engine",
    "(Motrix Next) so they are multithreaded, resumable and visible in the download manager.",
    "",
    "Use instead:",
    "  " + FORWARDER + ' "' + target + '" --out=<filename>',
    "",
    'Options: --dir=<dir> for the destination, --header="K: V" for headers,',
    "--no-wait to enqueue and return immediately (then query with --status <gid>).",
    "A blocked command is never partially executed."
  ];
  const shown = command.length > 240 ? command.slice(0, 240) + "..." : command;
  lines.push("", "Blocked command: " + shown);
  return lines.join("\n");
}
function apply(ctx) {
  ctx.on("tools/pre-execute", async (exec, next) => {
    let hit;
    try {
      const name = typeof exec?.name === "string" ? exec.name : "";
      hit = inspect(name, exec?.arguments);
    } catch {
      return next();
    }
    if (hit === void 0) return next();
    const args = exec?.arguments;
    const command = typeof args?.command === "string" ? args.command : "";
    const reason = denialMessage(hit.rule, hit.url, command);
    try {
      ctx.logger?.info("download-guard: blocked " + hit.rule + (hit.url === void 0 ? "" : " (" + hit.url + ")"));
    } catch {
    }
    return { kind: "deny", reason };
  });
}
export {
  apply,
  denialMessage
};
