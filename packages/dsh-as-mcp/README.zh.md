# dsh-as-mcp

把一个正在运行的 **DeepSeek Harness** 暴露成 **MCP 服务**，让别的 agent —— Claude Code、
Codex、另一个 DSH、CI 任务、你自己写的脚本 —— 都能驱动它：创建工作区、新建会话、把编码
任务交给 DSH 的 agent、读写文件、执行命令。

端点跑在 DSH 宿主进程**内部**，所以通过 MCP 建出来的会话就是真正的 DSH 会话：它实时出现
在 DSH 界面里，跑在 DSH 沙箱中，受和你手敲一样的那套权限策略约束。agent 本身没有任何东西
是被重新实现的。

---

## 安装

```bash
dsh plugin add dsh-as-mcp
```

从本地目录或 tarball 安装：

```bash
dsh plugin add /path/to/dsh-as-mcp
dsh plugin add ./dsh-as-mcp-0.1.0.tgz
```

`dsh plugin add` 会把包记进 profile 的 `dsh.profile.bundles`，包内的 `cordis.patch.yml`
负责提供插件行和默认配置。**装完要重启 DSH**：bundle patch 是启动时读取的，不热重载。

确认这一层已经合成进去：

```bash
dsh --profile <名称> --dump-config | grep -A 30 '# == dsh-as-mcp'
```

## 让客户端接进来

每个请求都要带 bearer token。解析顺序：

1. 插件配置里的 `auth.token`；
2. `$DSH_HOME/dsh-as-mcp/token`；
3. 都没有时在首次运行生成并写入该文件，权限 `0600`。

默认端点是 `http://127.0.0.1:8790/mcp`。

**支持 HTTP 的客户端**（Streamable HTTP）：

```json
{
  "mcpServers": {
    "dsh": {
      "type": "http",
      "url": "http://127.0.0.1:8790/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**只支持 stdio 的客户端** —— 用随包提供的桥接脚本，它把每条 JSON-RPC 消息通过 HTTP 转给
端点：

```json
{
  "mcpServers": {
    "dsh": {
      "command": "npx",
      "args": ["-y", "dsh-as-mcp"],
      "env": { "DSH_AS_MCP_TOKEN": "<token>" }
    }
  }
}
```

`dsh-as-mcp --help` 会打印它将使用的端点和 token 状态。

**先调 `dsh_info`**。它会返回端点、token 的来源、哪些工具组开着，以及——这点很关键——当前 profile
实际提供了哪些 harness 服务，这样客户端能区分「这个 profile 没有 shell」和「这条命令执行
失败了」。

## 工具

| 工具 | 作用 |
| --- | --- |
| `dsh_info` | 端点、token 来源、已启用的工具组、可用的 harness 服务。 |
| `workspace_create` | 把一个目录注册成 DSH 工作区（目录不存在时先创建）。 |
| `workspace_list` | 列出所有工作区：id、路径、标题、会话数、目录是否还在。 |
| `session_create` | 新建一个绑定到工作区（或裸目录）的 DSH agent 会话。 |
| `session_list` | 存活会话摘要，按最近更新排序。 |
| `session_prompt` | 给 DSH 会话下发一个任务；默认等待本轮结束，返回回复以及 agent 调过的每个工具。 |
| `session_messages` | 读取会话的用户/助手对话记录。 |
| `session_cancel` | 让 agent 停下当前这一轮。 |
| `file_read` | 经 DSH 文件系统服务读 UTF-8 文件。 |
| `file_write` | 经 DSH 文件系统服务创建或覆盖文件。 |
| `file_list` | 经 DSH 文件系统服务列一层目录。 |
| `shell_run` | 经 DSH shell 服务执行一条命令。 |

典型的编码流程：

```
workspace_create { path: "/Users/me/project" }
  -> session_create { workspaceId: "..." }
  -> session_prompt { sessionId: "...", prompt: "给 CLI 加一个 --verbose 开关，并补一个测试。" }
```

`session_prompt` 是让 DSH **替你干活**的入口：DSH agent 自己规划、改文件、调它自己的工具，
还能派生子 agent。`file_*` 和 `shell_run` 用在你想自己动手、不想经过 agent 的场合。

## 安全

这个端点等于远程操控一个拥有 shell 权限的编码 agent。请把 token 当 SSH 私钥对待——插件自己也是
这么做的：没有任何工具会返回它的值。`dsh_info` 只报 token 的来源（文件路径或配置），不报明文，
所以调用方 agent 的上下文里不会攒下这个凭证。

- 监听绑定在 `127.0.0.1`，所有请求都做 bearer 校验——包括挂在 DSH 自身 web server 上的那条
  路由。把 `http.host` 改成 `0.0.0.0` 等于把同样的权力开放到你的网络，只在你自己的网关后面
  这么做。
- 用 `tools` 开关收窄暴露面。一个绝不该执行命令的 profile 就设 `tools.shell: false`，此时该
  工具根本不会注册，客户端连发现都发现不了。
- `approval.policy` 决定 DSH agent 想做一件本该问人的事时怎么办：
  - `inherit`（默认）—— 插件不参与应答。没有浏览器接进来时，需要审批的工具会解析为
    `unavailable`，即 agent 的动作**失败关闭**。
  - `allow` —— 插件对**它自己创建的**会话所发起的每个审批请求都批准，对其他会话完全不进入
    waterfall，所以你手动操作的会话仍然保持自己的策略。这是让无人值守的 agent 任务能跑通的
    前提，也确实实质性地扩大了 agent 可执行的范围。
- `file_write` 和 `shell_run` 是**调用方**的动作，不是 agent 的。它们走 harness 自己的文件
  系统与 shell 服务，所以这个 DSH 实例配置的沙箱和策略照样生效。

## 装进 DSH Desktop（需要重启）

`desktop` profile 由 Electron 保留，`dsh plugin --profile desktop add` 在普通终端会被拒绝，
所以要手动装。装完**必须重启 DSH Desktop**。

### 为什么必须重启

profile manifest 里的 `patchReload: live` 只对 **CLI 启动器**生效。免重启重组由
`watchUserPatches()` 实现，它位于 CLI 的 `runProfile()`（`apps/cli/src/profile-boot.ts`）里。
DSH Desktop 走另一条路：它调用 `@deepseek-ai/dsh-app-boot` 的 `boot()`，patch 列表在启动时
算好一次——应用源码里根本没有这个 watcher：

```bash
grep -rn watchUserPatches <dsh-desktop>/dsh-plugin-desktop/src/    # 无匹配
```

实测也一致：改完 profile 的 `cordis.patch.yml` 之后，应用日志一行都没新增，端口也没起来。

所以：**CLI 启动的 profile（`dsh --profile xxx`）改 patch 文件即时生效；DSH Desktop 必须重启。**
无论哪条路径，watcher 都只重组配置、不替换已加载的模块——改完 `lib/` 之后一样要重启。

### 万一重启后起不来

`~/.dsh/profiles/desktop/cordis.patch.yml` 清回 `[]` 即可，插件不会再参与启动；确认无误后
再逐项排查。彻底移除：`cd ~/.dsh/profiles/desktop && pnpm remove dsh-as-mcp`。

### 1. 打包并装进 desktop profile

```bash
cd /path/to/dsh-plugins/packages/dsh-as-mcp && pnpm pack --pack-destination /tmp

# raw pnpm，绕过 CLI 对保留 profile 名的限制
cd ~/.dsh/profiles/desktop && pnpm add /tmp/dsh-as-mcp-0.1.0.tgz
```

### 2. 把插件行写进 profile 自己的 patch 层

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`（把其中的 `[]` 替换为）：

```yaml
- insert:
    - id: dsh-as-mcp
      name: dsh-as-mcp
      config:
        http:
          enabled: true
          host: 127.0.0.1
          port: 8790
          path: /mcp
        tools:
          workspace: true
          session: true
          files: true
          shell: true
```

保存后**重启 DSH Desktop**，插件才会挂载。

> ⚠️ **不要同时把 `dsh-as-mcp` 加进 `dsh.profile.bundles`。** bundle 会贡献它自己的行，于是最终
> 组合里会出现**两行同 id**（`dsh --profile <name> --dump-config` 会直接显示出 2 行）。用 patch
> 层就只走 patch 层。反过来说，想让它跨重启常驻时，才改用 `dsh plugin add` 走 bundle 路线。

### 3. 冒烟验证

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/scripts/smoke.mjs
```

它会读 `<DSH_HOME>/dsh-as-mcp/token`、握手、列出工具、调 `dsh_info` 报出该 profile 实际挂载了
哪些 harness 服务，再调 `workspace_list`。通过时最后一行是 `OK`，失败则退出码非 0。

要跑一次真实链路（建临时工作区 → 建会话 → 交给 DSH agent 干活 → 打印回复与工具调用）：

```bash
node ~/.dsh/profiles/desktop/node_modules/dsh-as-mcp/scripts/smoke.mjs \
  --prompt "在当前工作区创建 hello.txt，内容为 hi，然后读回来确认"
```

### 4. 卸载

把 `~/.dsh/profiles/desktop/cordis.patch.yml` 清回 `[]` 并重启，插件就不再挂载。
要彻底移除：`cd ~/.dsh/profiles/desktop && pnpm remove dsh-as-mcp`。

## 配置

默认值随 `cordis.patch.yml` 一起提供。profile 自己的 `cordis.patch.yml` 按 `id` 覆盖该行，
而且覆盖是**整体替换该行的 `config` 对象**、不是深合并——你仍然想要每个键都得重新写一遍。
未知键会在启动时报错并指名是哪个键，因为一个被静默忽略的拼写错误意味着你的覆盖根本没生效。

```yaml
- id: dsh-as-mcp
  name: dsh-as-mcp
  config:
    http:
      enabled: true          # 插件自有的监听
      host: 127.0.0.1
      port: 8790             # 0 表示让系统分配空闲端口
      path: /mcp
      mountOnWebServer: false # 同时挂在 http://<dsh 主机>:<dsh web 端口>/mcp
    auth:
      token: ''              # 空：读取/生成 $DSH_HOME/dsh-as-mcp/token
    tools:
      workspace: true
      session: true
      files: true
      shell: true
    session:
      agentPreset: ''        # 空：用 harness 默认
      provider: ''           # 必须和 model 成对出现
      model: ''
      promptTimeoutMs: 900000
    limits:
      maxReadBytes: 1048576
      shellTimeoutMs: 120000
    approval:
      policy: inherit        # inherit | allow
```

## 设置面板

宿主挂载了 settings 服务时（DSH Desktop 与 `dsh web` 都有），插件会在设置面板里贡献一个
**MCP 服务** 分组。它编辑的就是上面那段配置所在的 `dsh-as-mcp` 命名空间——面板和文件是同一个
值的两种视图，不是两份副本。

所有改动**即时生效**：

| 改动 | 效果 |
| --- | --- |
| 工具开关 | 该组在下一次 `tools/list` 中消失或出现；被关闭的工具是真正不存在，调用它会报“未知工具”，而不是执行后被拒绝 |
| 上限、会话默认值 | 下一次调用开始时读取 |
| 令牌 | 下一次请求就要求新值，旧令牌立即失效 |
| `enabled`、`host`、`port`、`path`、`mountOnWebServer` | 监听器会被搬走 |

最值得说清的是改端口：插件会先停掉旧监听再起新的，所以端点是真的搬了。如果新端口被占用，
绑定错误会显示在面板和 `dsh_info` 里，而不是被吞掉。

令牌是**只写**的。它的明文从不离开宿主进程，所以面板只能显示“是否已设置”和一个清除按钮；
可复制的客户端配置用 `<token>` 占位，并指向令牌文件。实时端点状态（是否在监听、绑定错误、
已启用的工具组）由 DSH connection 层上的一条只读路由提供——它在该层的 Host/Origin 与浏览器
cookie 围栏**之内**，因此自动继承 DSH 自己的鉴权，绝不会暴露在一个裸端口上。

注册 settings 命名空间需要 `@deepseek-ai/schemastery`，DSH 里没有绕开它的路径。本包把它声明为
**可选** peer 并用动态导入加载：宿主提供不了时，只失去这个分组，其他能力一个不少——端点继续
按配置文件运行。`dsh_info` 和冒烟脚本都会告诉你当前是哪种情况。

## 兼容性

- **Harness** ≥ `0.1.5-rc.1`（开发与验证基于 `dsh-v0.1.5-rc.1`，即 DSH Desktop 2.0.9 内置
  的版本）。
- **Node** `^22.19.0 || >=24.0.0`。
- **没有硬 `@deepseek-ai/*` 依赖。** DSH 会把插件声明的每一个 `@deepseek-ai/dsh-*` peer 范围拿去
  和唯一那个运行时版本比对，所以本包一个都不声明：所有能力通过 `ctx.get(name)` 做结构化解析，
  配置 schema 是手写的 [Standard Schema](https://standardschema.dev) 而不是 schemastery
  schema——而 Cordis 的 `resolveConfig` 实际消费的就是 Standard Schema。于是它安装、加载都
  没有版本闸门，也不会因为某个 peer 没装上就在 import 期直接失败。
  唯一的例外是 `@deepseek-ai/schemastery`，且声明为**可选** peer：DSH 里没有免 schemastery 的
  settings 注册路径，所以想要设置面板就必须声明它——但声明为可选意味着没装上也只失去面板，
  核心功能不受影响。这与生态里已有的第三方插件（`dsh-tokenledger`）做法一致。

## 设计说明

- **能力探测，而非 `inject`。** 插件能在一个既没有 web server、也没有会话服务、也没有文件系统
  接缝的裸 CLI profile 里加载，然后由每个工具明确报出缺少哪个服务、该由哪个 bundle 提供。
  如果声明 `inject`，loader 会直接拒绝挂载插件——对一个能力桥来说这是更差的答案。
- **如何等一轮结束。** harness 没有提供「等待这一条消息对应那一轮」的 API——
  `sessionController.prompt()` 在消息入队后就立即返回。所以 `session_prompt` 会轮询持久会话
  日志，找 `source.rpcId` 等于它传给 `prompt()` 的 `requestId` 的那条 `user/message`——这正是
  session controller 自己做幂等检查时用的关联方式——然后等**那一轮**关闭。这个归属判断才是
  正确性的来源，而不是「看起来合理」：排队中的 prompt 在日志里是落在**正在跑的那一轮**的区间
  内部的，所以出现在我们消息之后的 `turn/end` 通常属于别人，不属于我们。同一会话上的轮次另外
  还做了串行化，因此两个并发调用方不会把 prompt 交错在一起、然后对「哪条回复属于谁」产生分歧。
- **文件系统。** 只有 `workspace_create` 和 `file_write` 为创建父目录用到 `node:fs` 的
  `mkdir`；harness 的文件系统服务有意不暴露 `mkdir`。其余读写一律走 `ctx.fs`，所以 DSH agent
  所处的路径规则与沙箱同样约束调用方。
- **没有删除会话。** harness 只有 `archiveSession`/`unarchiveSession`，没有 delete，本插件
  同样不提供。

## 开发

```bash
pnpm install
pnpm build       # tsdown -> lib/
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest
```

测试套件会打真实的 HTTP 到真实监听的端点、真的 spawn `bin/mcp-stdio.mjs`、并把插件加载进真实的
`@deepseek-ai/cordis` context（配置校验由 `resolveConfig` 执行），因此线协议、桥接脚本和
loader 契约都是被真正跑过的，不是 mock 出来的。

另有两个脚本针对**运行中的端点**，这是另一回事：

```bash
node scripts/smoke.mjs       # 握手、tools/list、dsh_info —— 线通不通？
node scripts/exercise.mjs    # 约 40 项断言：建工作区、开会话、让 DSH agent 写代码、
                             # 从磁盘读回来、运行它、检查对话记录，并确认失败路径可读
```

`smoke.mjs` 回答"这玩意儿会说 MCP 吗"，`exercise.mjs` 回答"外部 agent 真的能通过它驱动一个
DSH 实例吗"。它是唯一能抓住某一整类 bug 的检查——**测试桩比它所替代的 harness 服务更宽容**。
这类 bug 在本项目里造成过两次真实故障，且都落在主路径上，所以改动驱动后务必跑一遍。

## 许可证

MIT
