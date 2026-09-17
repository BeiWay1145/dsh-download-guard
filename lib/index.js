// src/index.ts
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// src/segment.ts
function splitSubcommands(command) {
  const segments = [];
  let current = "";
  let quote = "none";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "single") {
      current += ch;
      if (ch === "'") quote = "none";
      continue;
    }
    if (quote === "double") {
      if (ch === "\\") {
        current += ch;
        if (i + 1 < command.length) {
          current += command[i + 1];
          i += 1;
        }
        continue;
      }
      current += ch;
      if (ch === '"') quote = "none";
      continue;
    }
    if (ch === "\\") {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      quote = "double";
      current += ch;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      current += ch;
      continue;
    }
    if (ch === "|" || ch === "&") {
      const next = command[i + 1];
      if (next === ch) {
        segments.push(current);
        current = "";
        i += 1;
        continue;
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

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
  for (const segment of splitSubcommands(code)) {
    const hit = detectInSegment(segment);
    if (hit !== void 0) return hit;
  }
  return void 0;
}
var NULL_TARGETS = /* @__PURE__ */ new Set(["-", "/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"]);
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return t.slice(1, -1);
    }
  }
  return t;
}
function curlWritesFile(segment) {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "-O" || tok === "--remote-name" || tok === "--remote-name-all") return true;
    if (/^-[A-Za-z]*O[A-Za-z]*$/.test(tok)) return true;
    if (tok.startsWith("--output=")) {
      return !NULL_TARGETS.has(unquote(tok.slice("--output=".length)).toLowerCase());
    }
    if (tok === "--output") {
      const next = tokens[i + 1];
      if (next === void 0) return true;
      return !NULL_TARGETS.has(unquote(next).toLowerCase());
    }
    if (tok === "-o") {
      const next = tokens[i + 1];
      if (next === void 0) return true;
      return !NULL_TARGETS.has(unquote(next).toLowerCase());
    }
    if (/^-o./.test(tok)) {
      return !NULL_TARGETS.has(unquote(tok.slice(2)).toLowerCase());
    }
  }
  return false;
}
function wgetWritesStdout(segment) {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--output-document=-") return true;
    if (tok === "--output-document") {
      const next = tokens[i + 1];
      if (next !== void 0 && unquote(next) === "-") return true;
      continue;
    }
    if (/^-[A-Za-z]*O$/.test(tok)) {
      const next = tokens[i + 1];
      if (next !== void 0 && unquote(next) === "-") return true;
      continue;
    }
    if (/^-[A-Za-z]*O-$/.test(tok)) return true;
  }
  return false;
}
function detectInSegment(segment) {
  if (/\bcurl\b/.test(segment) && curlWritesFile(segment)) {
    return { rule: "curl-output", url: firstUrl(segment) };
  }
  if (/\bwget\b/.test(segment) && !wgetWritesStdout(segment)) {
    return { rule: "wget", url: firstUrl(segment) };
  }
  if (/\b(Invoke-WebRequest|iwr)\b/.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: "Invoke-WebRequest", url: firstUrl(segment) };
  }
  if (/\bInvoke-RestMethod\b/i.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: "Invoke-RestMethod", url: firstUrl(segment) };
  }
  if (/\bStart-BitsTransfer\b/i.test(segment)) {
    return { rule: "Start-BitsTransfer", url: firstUrl(segment) };
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
function forwarderPath() {
  try {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "aria2-dl.cjs");
  } catch {
    return "aria2-dl.cjs";
  }
}
function denialMessage(rule, url, command) {
  const target = url === void 0 ? "<URL>" : url;
  const lines = [
    "BLOCKED by dsh-download-guard: this command downloads a file to disk",
    "(matched: " + rule + "), and downloads must go through the local aria2 engine",
    "(Motrix Next) so they are multithreaded, resumable and visible in the download manager.",
    "",
    "Use instead:",
    '  node "' + forwarderPath() + '" "' + target + '" --out=<filename>',
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
