# dsh-download-guard

把「下载必须走 aria2」从**技能里的建议**变成**运行时的强制**。

## 为什么需要它

`aria2-download` 技能把规则写在提示词里，而**提示词只是建议**。实际发生的是：

| | aria2 通道 | 绕过通道 |
|---|---|---|
| 引擎 | aria2-next (Motrix Next) | node 单连接 https |
| 实测速度 | **11.78 MB/s** | **0.13 MB/s** |
| Motrix 可见 | ✅ | ❌ |
| 断点续传 | ✅ | 部分 |

同一条 4.76 GB 的 Windows 11 镜像，两条路差了 **约 90 倍**。而 agent 手头只要有一个 `download.cjs`，就会顺手用它——因为**在 shell 层面 `node download.cjs` 和 `aria2-dl.js` 长得一模一样**，没有任何机制能区分。

本插件把这条规则搬到运行时：**拦截工具调用，拒绝并给出正确的 aria2 命令**。

## 工作原理

监听 cordis 的 `tools/pre-execute` 钩子（waterfall 模式），在**工具真正执行之前**裁决：

```
模型请求 pwsh("curl -o x.iso https://...")
    ↓
tools/pre-execute 钩子触发
    ↓
识别为下载 → 返回 { kind: 'deny', reason: '<改用 aria2 的完整命令>' }
    ↓
工具被拒绝，reason 原样呈现给模型（工具体从未执行）
```

### 为什么不用审批钩子

`approval/request` 在**审批策略为 `never` 时会失效**——`ApprovalService.decide()` 在派发 waterfall **之前**就 `return "rejected"`：

```js
if (this.effectivePolicy(session) === "never") return "rejected";  // ← 在这里返回
const answer = ... this.ctx.waterfall(..., "approval/request", ...)   // ← 永远走不到
```

而 `tools/pre-execute` 是**独立的 waterfall，没有这个短路**，所以任何策略下都有效。

## 拦截规则

判据来自技能本身：**是否需要把字节写到磁盘**，而不是 URL 长什么样、文件多大。

| 拦截 | 放行 |
|---|---|
| `curl -o F` / `curl -O` / `curl --output F` | `curl https://api.x/status`（只输出到 stdout） |
| `wget <url>`（默认落盘） | `wget -O - <url>`（显式输出到 stdout） |
| `Invoke-WebRequest ... -OutFile F` | `Invoke-WebRequest https://api.x/status` |
| `Invoke-RestMethod ... -OutFile F` | `Invoke-RestMethod https://api.x/data` |
| `Start-BitsTransfer ...` | — |

**明确不拦**（按设计）：

- `pip install` / `npm install` 等包管理器——不在本插件职责内
- `git clone`——git 自有传输层
- 注释行里的命令（shell 不会执行）
- 非 shell 工具（即使参数里含 `curl -o` 字样）
- **仅仅是提到某文件名**（例如日志里打印 `download.cjs`）——曾有一条按文件名匹配的规则，因误伤已删除

检测**刻意偏向漏判而非误判**：拦截一条正常命令是可见的体验倒退，而漏掉一次下载只是现状。

## 拦截后模型看到什么

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

**URL 会被自动提取并填进建议命令**——被拒绝的一方不需要猜该怎么改。

## 安装

```bash
cd ~/.dsh && dsh plugin --profile <your-profile> add "dsh-download-guard@github:BeiWay1145/dsh-download-guard"
```

安装后**重启 DSH** 生效。

## 已知边界

- **拦不住「命令内部的下载」**：`python script.py` 里用 `urllib` 下载，钩子看到的是 `python script.py`，看不到它内部在做什么。彻底收口需要本地代理层，不在本插件范围。
- **拦不住非 DSH 发起的下载**：在 DSH 之外的终端里 `curl -o` 不受影响。
- 依赖宿主提供 `tools/pre-execute` 钩子（已在 DSH 0.1.5-rc 系列上实测）。

## 开发

```bash
npm install
npm test          # 构建 + 检测器单测 + 真实 ToolRuntime 运行时测试
npm run typecheck
```

测试分两层：

- `tests/detect.test.mjs` — 纯函数检测规则（38 项，含大量「必须放行」的反例）
- `tests/guard.runtime.mjs` — 把**构建产物**装进真实 cordis + ToolRuntime，验证 deny 真的拦住了工具体

运行时测试会自行在本机寻找已安装的 DSH 树；找不到时**跳过而非失败**，这样裸克隆仓库也能通过。

## 许可

MIT
