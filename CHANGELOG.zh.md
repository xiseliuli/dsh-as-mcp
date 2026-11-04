# 更新日志（中文摘要）

`dsh-as-mcp` 每个版本的中文摘要，最新在前。

- 这是**摘要**，不是全文翻译：实现细节、实测数字、设计取舍和完整条目以英文的 [CHANGELOG.md](./CHANGELOG.md) 为准，英文版是权威记录。
- 两份文件的**版本标题必须完全一致**（集合与顺序），由 `tools/check-docs.mjs` 强制检查——发布时漏写中文条目会让检查失败，中文读者不会悄悄落后一个版本。
- 版本号遵循 SemVer；项目仍是 pre-1.0，所以 minor 是功能，patch 是修复或文档。

## 0.52.86

- fire-and-forget 的 turn 现在能自己报告结束，现代（2026-07-28）MCP 客户端不必再轮询。端点宣布 `resources.subscribe`，注册一个可读的合成资源 `dsh://session/<id>/turn`（内容与 `session_status` 一致），并且当 `session_prompt { wait: false }` 被接收时若有打开着的 `subscriptions/listen` 流，就用与阻塞调用相同的等待去盯这一轮，结束时推送 `notifications/resources/updated`——完成、失败、取消，或没有 `turn/end` 而消失都算。watcher 只在有人监听时才会安排（没有订阅者的 fire-and-forget prompt 依旧零额外成本）、每个 request id 只一个（幂等重试不会重复推送），并且受同样的 `promptTimeoutMs` 约束：等待超时的 watcher 没有看见结束，就不推，而不是宣称一个假的结束。不订阅的客户端（包括所有 2025 客户端与 stdio 桥）不受影响，继续轮询 `session_status`；监听流必须在 prompt 被接收**之前**打开。
- 服务端 instructions 与 `session_prompt` 的 `wait` 选项现在把订阅契约写在客户端真正会读的地方。`src/mcp/push.ts` 持有每端点的订阅总线和推送调用，driver 负责安排/清理 watcher；`tests/push-notifications.test.ts` 用假的会话日志固定住 URI 编码、订阅者门控、能力宣告、可读模板、两句 instructions，以及「只推一次」。
- 工具面、旧的 stateless 传输与端点其余行为不变。

## 0.52.85

- MCP 服务的设置面板现在也渲染在**插件页**：本 bundle 自己的详情页里。浏览器半边把同一个 `McpSection` 注册进宿主的 `plugins.bundle.config` keyed 插槽，key 就是 bundle 的包名（页面按 `entryKey = pkg.name` 派发），所以改设置不必每次都打开 DSH 设置。两个入口是同一个组件、同一个共享配置表单与同一份快照——一个值两扇门，任一边写入另一边无需刷新即可见；新单元格和设置页一样，只在宿主确实提供这一项配置表单时注册（`ctx.configForms.whileServed`）。插件页把 bundle 配置放在一个没有标题的裸 `section.detailSection` 里，所以这个单元格让面板自己画标题；设置页入口仍沿用设置外壳的导航标题，不重复画。宿主插件页没有该插槽时什么都不显示，设置入口不受影响。`src/client/contract.ts` 现在同时描述两种插槽（list 的 `id` 与 keyed 的 `key`），并引用了 harness 的 `KindOptions` 形状，不再假设只有 `settings.section`。
- `tests/client-half.test.ts` 把新入口钉在构建产物与源码上：单元格以包名作 key（key 写错不会报错，只是静默不渲染，因为页面判断"有没有配置"就是已注册 key 的集合）、两个入口在同一道 `whileServed` 门后、且只有一个 store 同时支撑两者；构建出的 `lib/client.js` 仍然只 require 平台预置模块。
- 除 MCP `initialize` 宣告的版本号外，端点、工具与宿主半边均无变化。

## 0.52.84

- GitHub 安装指引改为先给「能长期有效的放行方式」：pnpm 按 `<name>@<git url>`（不带 `#<ref>`）匹配 git 依赖的构建，一条 `allowBuilds` 条目就能覆盖之后的所有 commit；原文先让读者抄 pnpm 打印的、钉在 commit 上的 key（`…/tar.gz/<sha>: true`），上游一 push 就失效，每更新一次都得重新手动放行。同时纠正本页两条命令的实际门槛：`github:…` 与 release `.tgz` 都按 tarball 拉取，所以按仓库 URL 放行需要 pnpm ≥11.19.0（11.11.0 只覆盖克隆形式的 git 依赖）；pnpm 10 上该开关叫 `onlyBuiltDependencies`。并新增「不放行构建」的通道：npm 与预构建的 Release 资产，两者都不执行 `prepare`。
- `tools/check-docs.mjs` 新增漂移检查：只要 `package.json` 还带 `prepare` 且 `lib/` 仍在 `.gitignore` 里，中英两份 README 就必须带上由 manifest 推导出的 key（`dsh-as-mcp@git+https://github.com/xiseliuli/dsh-as-mcp.git`）并点名 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；改包名或仓库名、或提交 `lib/` 删掉 `prepare`，检查会失败或自动不再要求这段——不会再把一个匹配不上任何东西的 key 留在文档里。这条来自 issue #1：Plugin Hub 1.6.5 自己的 npm 反查没命中本包、回退到 git 通道，pnpm 的构建门禁拦下 `prepare`，而 DSH 只打印通用提示，读者只能自己抄 key。
- 除上述安装说明外无行为变化：构建产物与各工具与 0.52.83 相同，差别只有 MCP `initialize` 宣告的版本号。

## 0.52.83

- 首次接入的 MCP 客户端现在能在它真正会读的地方看到上报契约：`initialize` 指令、`session_prompt` 的描述与 `wait` 选项都写明"`wait: false` 启动 → 用 `session_status` 跟进（`waitMs` 让变化即刻返回）"，以及失败通道（`turn.failure` = `{kind, message}`；正常完成不带 failure 块）。`session_prompt` 首次提供 output schema（含 `turn.failure`）；`session_status` 的 output schema 从只有 `sessionId`/`running` 扩展为完整报告（`idleMs`、`stalled`、`failure`、`lastTurn`、`changed`、`waitedMs` 等），schema 感知的客户端不必猜。很多 MCP 宿主不会把 `initialize.instructions` 传给模型，所以工具描述才是唯一可靠的首屏说明——这些措辞现在由测试固定，而不是靠习惯维护。
- `tools/live-checks.mjs` 新增 onboarding 检查：真实端点必须返回非空指令且点名跟进方式，两个工具必须保留这些句子与 schema 字段。这样以后误删契约文字会直接检查失败，而不是让功能悄悄变成"不可发现"。0.52.83 实测：单次启动（搜索索引开启）下 live-checks **195/195**（`--with-model --with-subagent`，含 6 条 onboarding 检查）、验收 **166/166**。

## 0.52.82

- 新增中文更新日志：`CHANGELOG.zh.md` 与英文 `CHANGELOG.md` 的版本标题一一对应，每个版本 1–3 条中文摘要。`tools/check-docs.mjs` 会校验两份文件的版本集合与顺序，并要求每个版本至少有一条中文要点——发布时漏写中文条目无法通过检查。它是摘要而非全文翻译：实现细节、实测数字与设计取舍以英文版为准（权威记录），两份文件互相链接，并随 npm 包发布（`files` 已包含）。
- 用故障注入补齐 0.52.81 的"真实失败结束"证据缺口：令临时 profile 的凭据失效后，真实 turn 以 `turnEndReason`/`turn.failure` = `{kind: "error"}` 结束（AUTH 401、空回复、478 ms 结算而不是 120 s 超时）；运行中把会话日志目录改名移走同样得到 `error`（ENOENT、13.8 s 结算）；运行中 `kill -9` harness 后冷启动读取，`session_status.lastTurn.reason` 为 `{kind: "interrupted"}`、`failure` 同为 `interrupted`；真实运行中的 turn 静默 62.9 秒后 `stalled` 变为 true。两条等待期检测仍只有单测覆盖：`unreadable`（harness 会先把无日志的 turn 以 `error` 关闭）与 `vanished`（崩溃在冷读时被合成为 `interrupted`）。`docs/LIVE-VERIFICATION.md` 已补上已验证行，并把剩余缺口收窄；完整过程（环境、原始回复、凭据优先级这个坑）记录在 `docs/FAULT-INJECTION-2026-11-03.md`。

## 0.52.81
- 新增 `session_status` 工具：报告单个会话的实时状态，包括是否有 turn 正在运行、当前的 turn 与 step、最新持久事件（`lastEventSeq`/`lastEventAt`）、日志静默时长 `idleMs`、运行中的 turn 静默一分钟后的 `stalled`，以及上一 turn 的结束方式和异常结束时的规范化 `failure`；`waitMs` 可把调用变成 long-poll，只读且只读一次 durable log。
- `session_prompt` 现在把失败的 turn 作为 `turn.failure`（`{kind, message}`）返回，覆盖 `error`、`blocked`、`max-tokens`、`interrupted` 与无法识别的结束方式，并新增 `unreadable` 与 `vanished` 两种等待期自身检测到的状态。
- 等待进度通知区分两个数字（形如 `turn 3: 2 tool call(s), 41s elapsed, log quiet for 12s`）；两份 README 表格、能力审计的工具数、`docs/LIVE-VERIFICATION.md` 已更新，实测 live-checks **189/189**、acceptance **166/166**。

## 0.52.80
- 修复：在 harness 已打开 turn 但 prompt 尚未提交的窗口内发生的取消，不再让等待中的 `session_prompt` 一直跑到超时；驱动会记录每会话的取消代次，发现递增即以 `turn.aborted: true` 结束。实测同样取消原先在 30 s `timeoutMs` 下 29995 ms 才返回 `aborted: false`，修复后 18 ms 即结算。
- 完整 live sweep 改为在打开 session-search 索引且 `DSH_PERMISSION_MODE=danger-full-access`（`tools/sweep-local.sh`）下运行，实测 live-checks **180/180**、acceptance **166/166**。
- 截断上限改为带凭据的断言（`maxArgumentChars: 200`、`maxReplyChars: 40` 需返回 `truncated: true` 并附原始 `argumentsBytes`/`replyChars`）；新增不随包发布的维护工具 `tools/clean-probe-sessions.mjs`，并记录 `docs/INCIDENT-2026-11-03-session-log-deletion.md`。

## 0.52.79
- 两个选项改为按效果断言：`session_list` 仅在设置 `includeTitle` 时折叠标题，`session_usage { sinceSeq }` 返回窗口化汇总（turn 与 token 均少于全量日志）而非忽略参数。
- 实测 full 163/163、session-only 95/95，README 表格与矩阵已更新。

## 0.52.78
- 两个选项按效果断言：`session_list { running: false }` 必须列出 `running: true` 排除的空闲会话；`session_usage` 在 `includeTurns: false` / `includeCost: false` 时须给出空的 `byTurn` 且 `cost.available: false`。
- 修正了首版断言（原以为字段应缺失，实际契约是空数组与 `cost.available: false`）；实测 full 161/161、session-only 93/93、cheap subset 110/47/64/68。

## 0.52.77
- `session_usage` 的 `includeSubagents` 改为双向断言：默认包含时 subagent 作为一行且总额含其消耗，显式 `includeSubagents: false` 时无 subagent 行、总额仅为会话本身（实测 55499 对 36808 tokens）。
- 首版检查误设默认值为 `false` 而在实测中失败，代码与两份 README 本就写作 `true`；该文档与代码不一致的情形已记录。

## 0.52.76
- 文档补充：该端点每个会话同一时间只运行一个 turn（`enqueueTurn`），同一连接发来的第二条 prompt 会在运行中的 turn 之后等待（20 s 的 turn 实测 21.9 s）。
- 要排到运行中 turn 之后需要第二个 MCP client，这一点已写入两份 README 的 `session_prompt` 行；依赖该时序的取消断言被移除。

## 0.52.75
- 取消等待返回后，检查还要求 turn 真正停止：会话须在 20 秒内从 `session_list { running: true }` 中消失。
- 实测 full 159/159、session-only 91/91，README 与矩阵已更新。

## 0.52.74
- 必须在 turn 打开时执行的检查（取消、向运行中的 turn steer、turn 中途切换模型）不再固定 sleep 1.5–3 秒，而是轮询 `running` 过滤条件（最多 20 秒）并在 turn 出现时立即继续。
- 首版轮询了错误的会话变量（看到 3 个 turn 而非 2 个），断言立即发现，完整形态恢复为 158/158。

## 0.52.73
- 标题可见性检查不再固定 sleep 4 秒等待 harness 写入标题请求，而是最多轮询会话日志 20 秒，事件出现即停止。
- 改动后 `--with-model` 完整形态重跑为 158/158。

## 0.52.72
- 混合部署现在还检查第二个入口的准入：无 bearer 的请求以 `401` + `WWW-Authenticate: Bearer` 拒绝，错误的 bearer 同样被拒。
- 混合形态实测 116/116，两份 README 已记录。

## 0.52.71
- 混合跨入口部分新增状态检查：通过插件 listener 创建的会话能在 web-server 入口列出，通过该入口做的重命名由 listener 报告。
- 混合形态实测 114/114（109 + 5 个跨入口检查），两份 README 已记录。

## 0.52.70
- 新增 `hybrid` 形态（同时启用 listener 与 `mountOnWebServer`）及跨入口实测：经 DSH web server 进入的第二个 MCP client 须公布相同的工具、构建与 listener 状态，并看到相同的已注册 workspace。
- 实测 hybrid 112/112（109 + 3 个跨入口）、mountonly 109/109；构建该形态时发现模板 bug（hybrid 配置渲染成 `mountOnWebServer: false`），已修复。

## 0.52.69
- `tools/shapes.mjs` 新增 `mountonly` 形态（`http.enabled: false` + `mountOnWebServer: true`），`live-checks` 支持 `--mounted-only` 并期望 `listening: false`、`mountedOnDshWebServer: true` 及描述其位置的 endpoint 字符串。
- 实测 158 full、90 session、63 narrow、68 files+shell、109 mounted-only，cheap subset 109/46/63/68；两份 README 表格已更新。

## 0.52.68
- `dsh_info` 的 endpoint/listening 现在作为关系断言：`endpoint` 为可拨号 URL 当且仅当 `listening` 为 true，endpoint 由他处提供时明确不是 URL。
- 已实测 mounted-only 配置：DSH web server 上 `initialize` 可用、插件端口无监听，`dsh_info` 返回 `listening: false`、`mountedOnDshWebServer: true` 与 `/mcp (served by the DSH web server; ...)`。

## 0.52.67
- 端到端实测 `port: 0` 配置：插件绑定操作系统分配的端口 `61532`，`dsh_info` 返回 `endpoint: "http://127.0.0.1:61532/mcp", listening: true`。
- 面板自 0.52.66 起优先使用该实时 URL，同一问题的两个部分均已覆盖。

## 0.52.66
- 面板的客户端片段改用客户端真正可拨号的 endpoint：listener 在线时用实时 `status.url`（`port: 0` 时显示系统分配的端口），插件 listener 关闭而由 DSH web server 提供时用 `<this page's origin><path>`，加载期间回退到配置镜像。
- 非 URL 的状态字符串不再被当作 endpoint，选择逻辑位于 `dialableEndpoint` 并有覆盖各分支的单元测试。

## 0.52.65
- 未挂载状态路由（或 fetch 失败）的主机上，面板原先既不显示健康徽章也不给原因；现在会说明此处无法读取 endpoint 状态，健康信息仍隐藏。
- 隐藏是诚实状态，但静默缺失看起来像未完成的面板。

## 0.52.64
- 客户端配置在配置只读了一半时不再显示：此前会渲染出 `http://127.0.0.1:`（端口与路径缺失）却看似可复制。
- URL 改由 `endpointUrl` 提供，端口与路径齐全前返回 `undefined`，并把通配绑定改写为可拨号主机；单元测试覆盖半读与通配改写。

## 0.52.63
- 同一后台任务的两个视图现在互相校验：`shell_list { running: true }` 中的行在 `shell_output` 中须报 `done: false`，执行 `shell_kill` 后同一调用须报 `done: true`。
- 此前两个过滤条件各自被单独信任。

## 0.52.62
- 澄清文档：`workspace_list` 的 `sessionCount` 是注册表的 attach 列表（以 `workspaceId` 创建的会话），仅由 `cwd` 创建的会话不计入，因此该行可显示 0 而 `session_list { cwd }` 仍有会话。
- 实测检查同时断言两半：经注册创建的会话使计数变化，仅由 cwd 创建的不变。

## 0.52.61
- `workspace_list` 的 `sessionCount` 现在对照端点在该目录实际创建的会话检查：计数必须加一。
- 仅核对列表只能证明该字段是数字，此项证明它是对应 workspace 的真实计数。

## 0.52.60
- 配置样例检查现在覆盖两份 README：中文样例此前无人比对，可能在英文样例保持一致时独自漂移。
- 把 zh 样例的 `maxReadBytes` 改为 1048577 会报出 `DRIFT: README.zh.md sample says limits.maxReadBytes: 1048577, the default is "1048576"`，验证后还原。

## 0.52.59
- README 的 yaml 配置样例现在对照 `src/defaults.ts` 检查：所有标量（http 主机/端口/路径/开关、六个工具开关、session 字段、limits、approval 策略）须等于出厂默认值，因 profile patch 会替换整行配置。
- `agentTools.allow/deny: []` 仍记录为“空表示内置允许列表”，并断言为空而非与默认数组比较；通过把样例 `promptTimeoutMs` 改为 900001 验证会报出漂移。

## 0.52.58
- 漂移检查现在把 README 正文中的五个上限与执行约束的常量比对：`MAX_IMAGE_BYTES`（8 MiB）、`MAX_REQUEST_BYTES`（64 MiB）、`MAX_PROMPT_IMAGES`（4）、`MAX_SHELL_JOBS`（16）、`MAX_OWNED_SESSIONS`（1000）。
- 通过把 “8 MiB” 改为 “9 MiB” 验证会报出 `DRIFT: README.md claims 9 for the MiB image cap, the code says 8`，随后还原；两份 README 均已列出该检查。

## 0.52.57
- `docs/CAPABILITY-GAPS.md` 开头多个版本以来写着 “25 tools”，而代码实际为 28；该页现已改为 28。
- 漂移检查现在比对开头句与已注册工具数，此前只检查附录中的计数。

## 0.52.56
- 实测 turn 断言 usage 汇总与 harness 自身的 token 投影一致：`verifiedAgainstProjection === true` 且无 `projectionTotals`（该字段仅在两者不一致时出现）。
- 两个独立实现的一致性无法由单元测试提供；实测 full 153/153、session-only 89/89。

## 0.52.55
- 验证已记录的盲区：会话标题由一次不留下 usage 记录的 LLM 调用生成；实测检查通过 `shell_run` 读取会话自身的 durable log。
- 检查要求找到带 route 的 `session/title-llm-request` 且无对应 usage 事件，凭据的 `samples` 等于日志中 `assistant/message` + `assistant/attempt` 事件数；完整形态 152/152。

## 0.52.54
- acceptance 运行现在明确固定 fork 记账而非只断言 “inherited > 0”：子会话的 `inherited` 须等于切分时父会话总额，新建子会话 `totals` 为零，子会话运行一 turn 后 `totals` 等于该回复的 usage 而 `inherited` 保持父会话数值（且仅一行 `byTurn`）。
- acceptance 由 163 增至 166 项检查并全部通过，两份 README 已更新计数。

## 0.52.53
- prompt 图片附件现有实测覆盖：一个真实 turn 携带 1×1 PNG 并结算，五张图片的 prompt 在任何 turn 运行前被拒，不可读的图片路径返回点名该文件的错误。
- 首次尝试也确认了真实区别：仅供 `file_read_image` 字节嗅探的 1×1 PNG 作为 prompt 附件会被以 “Unsupported or malformed image data” 拒绝，因 prompt 路径会解码图片；检查改用正常编码的 2×2 PNG，README 说明附件必须可解码而非仅可嗅探，完整形态 150/150。

## 0.52.52
- 实测 `approval.policy`：为 `allow` 时 `session_create` 报 `approvalPolicy: "never"`（harness 的无人值守姿态），为 `inherit` 时回复不带策略、会话保持默认。
- `live-checks` 现对照 `dsh_info.config.approval` 断言该关系；两条分支均已运行，重测形态 147/88、cheap subset 104/45/59/65。

## 0.52.51
- 实测新的主机校验：`http.host: ''` 的 profile 不启动任何 listener 且输出点名该规则，`0.0.0.0` 按预期绑定。
- 非回环地址的 *warning* 存在于代码中，但插件 `log.warn` 输出未被该 harness 的 stdout 捕获，矩阵记录绑定行为并说明未观察到该警告。

## 0.52.50
- `http.host` 现做校验：空值被拒绝（否则会在操作者未表态时绑定所有接口，仅有一条日志警告），粘贴进该字段的 URL 同样被拒，前后空白会被裁剪而不再传入 `listen()`。
- 面板示例与 README 早已写 `127.0.0.1`，此项使配置与之一致。

## 0.52.49
- `http.port` 在配置校验中限定为不超过 65535：旧检查只要求非负整数，`70000` 能加载却在稍后以 listen 错误失败。
- 错误信息给出取值范围，面板自身的 0–65535 边界现与主机规则完全一致。

## 0.52.48
- 漂移检查现在也把每个面板数字的最小值与主机 `positiveInt` 规则比对：对应键的面板字段须声明 `min: 1`。
- 通过把 `session.promptTimeoutMs` 降到 `min: 0` 验证会报出 `DRIFT: panel number "session.promptTimeoutMs" has min 0, but the host requires a positive integer (min 1)`，随后还原；两份 README 已列出该检查。

## 0.52.47
- 漂移检查现在把每个面板 `select` 与配置 schema 校验所用的导出枚举（`SESSION_SCOPES`、`APPROVAL_POLICIES`）比对：提供主机会拒绝的选项比自由文本更糟。
- 新增的 select 若缺少映射会直接失败而非静默漂移；通过删除 `allow` 选项验证会报出 `DRIFT: panel select "approval.policy" offers [inherit], APPROVAL_POLICIES is [inherit, allow]`，随后还原。

## 0.52.46
- 四个正整数设置（`session.promptTimeoutMs`、`limits.maxReadBytes`、`limits.shellTimeoutMs`、`limits.agentToolTimeoutMs`）在面板中现声明 `min: 1`，与主机 `positiveInt` 规则一致，用户不再能在写入失败后才知道取值被拒。
- 新增字段不变量测试：所有路径唯一（无遮蔽）、每个 `select` 带选项、每个 `number` 声明最小值且最大值不低于它。

## 0.52.45
- 数字字段不再在界面上保留未写入的值：主机将拒绝的草稿（空、只输入一半、越界）在失焦时被重置为上次提交的值，而不是在输入框仍显示如 `70000` 时静默无反应。
- 该规则移入 `parseNumberDraft` 并做单元测试（接受边界值，拒绝非法与越界值），文本字段不变。

## 0.52.44
- 把 **flake discipline** 写入 `docs/LIVE-VERIFICATION.md`，以 0.52.4x 各轮的四个案例成表：要求两条受限速通知的进度检查、可能错过已结束 turn 的 steer/switch、命令过短无法区分的 deadline 检查、以及在服务挂载前读取 `harnessServices` 的 shapes 驱动。
- 两份 README 均指向该小节。

## 0.52.43
- 对 acceptance 脚本施加同样的自造抖动审计：符号链接循环遍历的竞态窗口由 5 s 延长到 15 s（项目很小，该窗口只用于捕获无限跟随而非测速），后台任务输出轮询对 0.3 s 的任务给 10 s 而非 4 s。

## 0.52.42
- 又两处防止自造抖动：steering 检查的长 turn 改用 `sleep 10`（原为 8），确保 steer 不会在 turn 关闭后才到达；`shell_run` deadline 检查改为在 0.7 s 超时下运行 `sleep 15`，并接受 8 s 以内的结果，宽窗口仍能证明是 deadline 而非命令自然结束。
- 长命令没有额外开销，因为调用在 deadline 处即返回。

## 0.52.41
- 消除 turn 中途切换检查中的同类抖动风险：原先在由三条快速 `echo` 组成的 turn 启动 1.5 s 后切换路由，快速路由下 turn 可能已结束，切换会落到 *后续* turn 上。
- 现在 prompt 以 `sleep 6` 开头，保证切换落地时 turn 仍打开，并继续断言两条路由答复了同一个 turn。

## 0.52.40
- 在一次无法复现的完整形态 144/1 之后加固进度通知检查：可疑断言要求两条间隔超过 500 ms 的通知，而发送端限速约每秒一条，快速 turn 合法地只会发出一条。
- 改为要求第一条通知在 turn *进行中* 到达，且多条到达时彼此分散；两次完整形态与一次会话形态随后通过（146/146 与 87/87），两份 README 已更新计数。

## 0.52.39
- `session_prompt { mode: "steer" }` 现与队列 steer 路径分开的实测证据：被 steer 的 prompt 在运行中的 turn 内得到答复（回复带标记、无超时、未中止），两条 prompt 加一次 steer 仍只记录两个 turn。
- 先探测后固化；重测六形态 145、session+usage 86、narrow 59、files+shell 65（cheap subset 104/46/59/65）；`tools/shapes.mjs` 现会在汇总中打印失败检查名。

## 0.52.38
- 修正设置面板的一处错误显示：主机未挂载状态路由（或状态 fetch 失败）时 `readStatus` 返回 `undefined`，组件却仍标记读取成功并渲染 “not listening” 徽章。
- 徽章现在只在真正读到状态时出现，后续轮询读不到时再次消失；源码级测试以 `setStatusRead(next !== undefined)` 加 `statusRead &&` 门控防止回归。

## 0.52.37
- `tools/release.sh --shapes` 把形态驱动作为发布步骤运行（加 `--with-model` 会消耗 turn）；驱动现在为每个形态选取 **free ports**，不再假定 8821/8822 并杀掉其上的进程。
- 端到端验证 `release.sh --skip-tests --shapes` 报出 103/44/59/65（cheap subset），README 说明这些与 143/84 行不同是因为后者用 `--with-model` 测量。

## 0.52.36
- `tools/shapes.mjs` 把手工测量的部署矩阵变成一条命令：按形态启动临时 profile、安装打包 tarball、等待 harness 服务挂载、运行 `live-checks`、打印计数并清理。
- 端到端复现表格（143/84/59/65，`--with-model`）；编写过程中发现真实启动顺序：HTTP socket 在 harness 服务挂载 **之前** 就已应答，驱动现轮询 `dsh_info` 直到 controller 可见。

## 0.52.35
- 在当次构建上重新测量部署形态矩阵的每一行：六组全开在 `--with-model` 下为 **143/143**（表格原记的 130 来自加入后续检查前的构建），收窄形态复测为 84/84、59/59、65/65。
- 两份 README 已更新修正后的数字。

## 0.52.34
- 两份 README 现在都载有最近四轮产出的部署形态矩阵：六组全开（28 个工具、`--with-model` 下 130/130、acceptance 163/163）、`session+usage`（13 个工具、84/84）、`workspace+session+agentTools+usage`（18 个工具、59/59）、`files+shell`（11 个工具、65/65）。
- 同时说明跳过行为，便于运维在对比收窄部署时知道哪些未被验证。

## 0.52.33
- 验证 **session-only** 部署形态（只想驱动 agent 的客户端会用的形态）：关闭 `workspace/files/shell/agentTools`、开启 `session` 与 `usage`。
- `live-checks --with-model` 报出 84/84 项、0 失败：路由、`reasoningEffort`、usage 凭据、transcript turn 窗口、进度/取消、编排、steering 与幂等性均运行，每个文件/shell/workspace 小节降级为显式跳过。

## 0.52.32
- 在 **minimal** 部署（仅开 `files` 与 `shell` 两组）上验证整套检查：11 个工具公布、11 个可用、17 个不可用并给出原因，四个被禁组均被点名，session/usage/queue/search 小节降级为显式跳过，共 65/65 项、0 失败。
- 两份 README 现说明脚本可验证收窄部署，而不只是全开部署。

## 0.52.31
- 可用性契约现在检查禁用组路径：`tools.files: false` 与 `tools.shell: false` 的 profile 上，每个禁用组的原因须点名运维会拨动的开关，同时 `availableTools` 仍等于公布的 `tools/list` 集合（探测时公布 18 个、可用 18 个，`file_read` 原因为 “the files tool group is disabled”）。
- 顺带发现 `live-checks.mjs` 自身缺陷：workspace 小节无条件写文件，files 组关闭时以 “Tool file_write not found” 中断；现按公布的工具面门控并报为跳过。

## 0.52.30
- 四个边界契约有了实测检查：未知 id 的 `workspace_delete` 返回 `deleted: false` 而非失败；无会话的 cwd 上 `session_list` 返回空列表与 `total: 0`；仅含空白的 `session_rename` 标题在触碰 harness 前被拒；未知会话上的 `dsh_tool_list` 返回空工具列表加点名该会话的 `scopeError`，而非传输失败。

## 0.52.29
- 设置面板的 token 掩码现在只对长度至少 **16 个字符** 的 token 显示四位前缀（即主机已给出警告的阈值以下不显示）。
- 旧阈值为 9，导致 9–15 字符的 token 会显示四位、接近短 token 的一半；测试固定该边界（15 位全掩码，16 位显示 `abcd••••••••`）。

## 0.52.28
- 文件工具共享的 `cwd` 契约现有实测检查：相对写入可通过同一基准读取与列出（`file_list { path: ".", cwd }`），缺失的相对路径在错误中给出解析后的文件。
- 这些检查开销很小，不消耗 turn。

## 0.52.27
- `session_fork` 的两种切分形式新增否定式实测：同时传 `atSeq` 与 `atTurn` 被拒（“pass atSeq or atTurn, not both”），未知 `atTurn` 会列出日志实际记录的 turn 而非含糊失败。
- 两者复用 `--with-model` 已有的两 turn 会话，不额外消耗 turn。

## 0.52.26
- `file_read_image` 格式覆盖：实测检查把 **GIF**、**WEBP** 与 **BMP** 头分类为各自 MIME 类型，与既有 PNG/text/missing/超上限用例并列。
- 首次误以为不支持 BMP 而失败：`file_read_image` 能读 BMP，拒绝 BMP 的是 prompt 附件（格式列表更窄）；现两侧都检查，`session_prompt { images: [bmp] }` 会以列出的可接受格式拒绝（不消耗 turn），检测按 magic bytes。

## 0.52.25
- `idempotencyKey` 有了跨客户端证据：acceptance 只覆盖单客户端重试，而两个 harness 实例可驱动同一会话。
- 实测检查带 key 发送、经 *第二个* MCP client 重发同一 key（期望返回已记录的 turn 与相同回复）、再用该 key 配不同内容（被拒），并断言只运行了一个 turn。

## 0.52.24
- 两个边界契约有了实测检查：`file_read` 的 offset 位于 EOF 时是空的完整读取（`truncated: false`，无 `nextOffset`），越过 EOF 的 offset 返回空而非错误，使分页循环能干净终止；`session_queue` 传入未知 `messageId` 时以可读信息拒绝（“queued item is no longer pending”）。
- 首轮两项失败原因在脚本而非插件：EOF offset 用 JavaScript 字符串长度计算而工具按 **bytes** 计数（'€' 为一个字符三个字节），队列正则不接受 “no longer pending” 措辞；均已修正，README 现说明分页 offset 是字节偏移。

## 0.52.23
- 编排实测检查现在会在等待时编辑待处理消息（`action: "edit"`）：取消后保留的队列条目文本被替换，之后的 transcript 须包含编辑后的文本而不含原文。
- 只改变列表显示的编辑无法通过该检查。

## 0.52.22
- 探测并断言 `session_queue { action: "steer" }`：在休眠 turn 运行时入队的消息被 steer 进该 turn，其文本出现在已运行的 turn 内而非作为新 turn。
- 实测检查以 turn 数作证：三条 prompt 产生 **两个** turn，被 steer 的文本出现在 transcript 中（行不一定带 turn 编号，故以计数为据）。

## 0.52.21
- transcript 的 turn 窗口现在有了实测证据：在 `--with-model` 已运行的两个 turn 上，`session_messages { fromTurn }` 只返回较晚的 turn（及其回复），`toTurn` 则在其之前停止。
- 参数名与 `session_usage` 相同，并对照回复报告的 turn 编号检查。

## 0.52.20
- `session_set_model { reasoningEffort }` 现有实测证据：选择被应用并回显（`reasoningEffort: "high"`，模型不变）。
- 先探测后接入 `live-checks --with-model` 作为不消耗 turn 的断言；路由拒绝该 effort 时跳过而非失败，因此不假设每个 provider 都支持。

## 0.52.19
- 文件编辑实测检查补齐了此前只有写入覆盖的 compare-and-swap 方向：在另一客户端改动文件前读到的 hash 会让 `file_edit` 以当前 hash 拒绝并保持文件不变，重新读取 hash 后同一次编辑成功。
- 这是编辑操作丢失更新的窗口，文档已说明并现被实测覆盖。

## 0.52.18
- 又有两个文档化选项有了实测证据：`dsh_tool_call { maxResultChars }` 通过 agent 的 `read` 工具以 100 字符上限读文件，断言 `truncated` 与未截断的 `resultBytes`；`shell_kill { waitMs }` 带显式等待杀掉运行中任务并仍报 `status: "killed"`。
- 读取调用同时接受 `file_path` 与 `path` 两种参数形态，检查不绑定单一 harness 版本。

## 0.52.17
- 实测了 0.52.16 记录的选项，并修正了行为与措辞相反的文档：`workspace_create` 与 `file_write` 默认 **创建** 缺失的路径/父目录，以 `createDirectory: false` / `createDirectories: false` 作为严格模式。
- 检查现断言两个方向（默认创建、`false` 拒绝），以及 `file_list { maxDepth }` 限制递归遍历、`session_fork { atTurn }` 让子会话在较晚 turn 之前停止（后者复用已有两个 turn，不增加消耗）。

## 0.52.16

- 两份 README 并行补齐了此前**两边都缺失**、且不易自明的选项：`session_fork { atTurn }`、`session_set_model { reasoningEffort }`、`file_write`/`file_edit` 的 compare-and-swap `expectedSha256`、`file_write { createDirectories }`、`file_read`/`file_list { sha256 }`、`file_list { maxDepth }`、`shell_kill { jobId, waitMs }`、`dsh_tool_call { maxResultChars }`、`workspace_create { createDirectory }`，以及 `file_edit` 的 `oldText`/`newText` 名称。
- 中文 `file_read` 一行补上了英文行已有的 `sha256` 说明；`command`、`provider`、`content`、`timeoutMs` 这类自解释选项仍只用文字描述。

## 0.52.15

- drift 检查现在能捕获 0.52.14 手工修好的那类缺陷：某个 tool 选项只在一份 README 中出现。它按 tool 比较两份 README 中以代码片段形式提到的 `inputSchema` 选项名集合，集合不同即失败。
- 通过从英文 README 删除 `` `probeSearch` `` 验证，检查报出 `DRIFT: README.md never mentions option "probeSearch" of dsh_info, while README.zh.md does`，随后恢复即可通过；它只要求覆盖对称，不要求每个选项都被文档化。

## 0.52.14

- 修复了一处中英文行内容漂移：中文 `dsh_info` 行记录了 `probeSearch`（该选项 schema 中确实存在，且有测试与实际检查覆盖），英文行没有；英文行现已补上该选项的作用。
- drift 检查比较的是 tool 行的**集合**而非行内容，因此这类遗漏无法被机器捕获，此处明确记录而非静默修复。

## 0.52.13

- 验证了归属契约的另一半：**损坏**的 `owned.json` 会 fail closed。在 `session.scope: "owned"` 下创建的 session，其记录被替换为 `{not json at all` 并重启进程后变得不可读——损坏的记录只会隐藏 session，不会暴露它们。
- 探测前已复制原始记录，结束后逐字节恢复，并删除了临时 profile。

## 0.52.12

- 验证了 README 早已承诺的 `session.scope: "owned"` 重启行为：通过 endpoint 创建的 session 写入 `$DSH_HOME/dsh-as-mcp/owned.json`，杀掉并重启进程后同一 session 仍可读，而另一个 profile 日志中的 session 被以 scope 提示拒绝。
- 事后从真实记录中删除了探测用的 id，并删除了临时 profile。

## 0.52.11

- drift 检查又接管了一个此前漂移过的数字：`docs/CAPABILITY-GAPS.md` 附录中的 capability-probe 数量必须等于 `describeCapabilities()` 报告的数量（当前 22）。将文档改为 21 时检查报出 `DRIFT: ... says 21 capability probes, describeCapabilities() reports 22`，恢复后通过；两份 README 都列出了这项新检查。

## 0.52.10

- subagent 实机检查现在证明文档所述的两个视图差异：prompt 回复的 `session` 块不含 subagent 的 token，而 `session_usage` 把它作为一行包含在内。断言回复总量等于 self 行且严格小于报告总量。

## 0.52.9

- 修复了新加的测试内文档检查所捕获的漂移（同一 shell 中的 `2>/dev/null | tail -1` 掩盖了它）：0.52.8 的矩阵行引用了价格插件自身版本 `1.9.41`，检查会将其读成本插件的一次发布却无 changelog 条目；该行现写作 "the current `dsh-cost-meter` (1.9.x)"。
- 流程变更：0.52.8 安装时因测试失败用了 `--skip-tests`，从 0.52.9 起涉及测试/文档的轮次带测试发版，而不是跳过。

## 0.52.8

- 闭合金额一项：从 registry 向临时 profile 安装 `dsh-cost-meter@1.9.41`，将 receipt 与插件自身 ledger 对比——`costUsd 0.00008131200000000001, calls 2` 对 ledger 的 `cost 8.131200000000001e-05, calls 2`，浮点值与调用数一致，说明数字是透传而非重算。
- live-checks 现在断言：挂载价格插件时若 `dsh_info.usage.costAvailable` 为 true，receipt 必须由 `dsh-cost-meter` 定价；两份 README 都说明金额数字是插件 ledger 值的透传。

## 0.52.7

- 在临时 profile 中尝试金额核对，并记录了未能运行的具体原因：本机唯一的 `dsh-cost-meter` 安装被 hoist 在 desktop profile 内，复制其包目录会丢失依赖，import 报 `Cannot find package 'acorn'`；desktop profile 本身跑的是更旧的构建。
- 验证矩阵现在写明这一阻碍及其闭合方式（从 registry 向临时 profile 安装价格插件），取代此前含糊的 "compare on a known row"。无代码改动。

## 0.52.6

- 记录了 `session_queue` 一行的内容：id、text、图片数量，以及 harness 收件箱的 `source` 类型。经 endpoint 排队的消息实测报 `source: "user"`，因此该字段是 harness 的分类，**不是**客户端身份；两份 README 均如此说明，live 编排检查断言该行形状。

## 0.52.5

- 编排实机检查现在覆盖**第二个 MCP 客户端**：从另一连接排队消息，在第一个连接用 `session_queue` 看到它并撤回，断言被撤回的文本从未执行。队列存在于 session 上，因此连接级的 id 是单客户端测试看不到的缺陷。
- 从 DSH UI 本身排队的消息仍未验证（需要 UI）。

## 0.52.4

- 两个脚本集成套件（`smoke-script`、`exercise-script`）允许每个测试重试一次：高负载下整套运行出现过一次 smoke 套件超时，重跑即通过，断言是确定性的，重试可吸收调度抖动而不掩盖逻辑失败。
- 0.52.3 安装时该抖动留在了日志里，因为失败 grep 被截断；本条记录前套件已重跑两次通过。

## 0.52.3

- `session_tool_result` 补上了 owned scope 覆盖：在 `session.scope: "owned"` 下拒绝外部 session 的 tool result（否则可通过猜测 call id 读到输出），对 endpoint 创建的 session 仍正常返回。
- 行为本身早已正确（`assertSessionVisible`），只是其他 session 类工具都有拒绝路径的测试而它没有。

## 0.52.2

- 文档漂移检查现在也进入测试套件（`tests/docs-consistency.test.ts` 会 spawn `tools/check-docs.mjs`），因此单跑 `vitest run` 就能报告 README/changelog/wiring 漂移，而不是留到发版步骤；两份 README 都说明了它的运行位置。

## 0.52.1

- 记录并断言了模型切换的生效位置：运行中调用 `session_set_model` 会作用于该 turn 后续的模型调用。探针以 `deepseek-official/deepseek-flash` 开始一个 turn，中途切到 `deepseek-account/deepseek-flash`，一个 turn 报出两条路由，其 `byModel` 拆分（18 062 + 18 586）等于该行总量（36 648）。
- `session_set_model` 的描述、两份 README 和矩阵均如此说明，live-checks `--with-model` 可复现。

## 0.52.0

- 当一个 turn 使用多条路由时，逐 turn 用量行现在带 `byModel` 拆分；此前单行总量会掩盖昂贵的模型收了多少费。单路由 turn 省略该字段，常见情况无额外开销。
- usage-fold 测试覆盖多路由拆分、单路由省略和行总量；两份 README 都描述了该字段。

## 0.51.11

- 验证了两个此前列为未验证的项，并更正了一处说法：`read-only` 沙箱确实拒绝插件写入（`file_write` → "file access denied under read-only mode"；`shell_run` 可读但其重定向报 "Operation not permitted"），所以 "the harness policy still applies" 是实测而非架构推断。
- 分块请求体（无 `content-length`）**确实**有大小上限：70 MB 分块请求 71 ms 内返回 `413`，而合法的分块 `initialize` 返回 200。README 此前说分块请求 "not covered by this check"，低估了代码行为（`readJsonBody` 会统计流式字节），两份 README 已更新，中文安全章节补上了缺失条目；两行都从 "Not verified here" 移入已验证矩阵。

## 0.51.10

- `tools/release.sh` 接受 `--with-model` 以及 `--full-live` 简写（等价于 `--with-model --with-subagent`）。此前只解析 `--with-subagent`，文档中的关闭桌面命令会因未知参数失败；README 与 usage 头部现已与脚本一致。

## 0.51.9

- 细化了 subagent 路由语义：继承发生在**spawn 时**，而非 session 创建时。探针在 `deepseek-official/deepseek-flash` 上应答，把 session 切到 `deepseek-account/deepseek-flash` 后再 spawn，子 agent 按切换后的路由计费。
- 两份 README 现在写 "the parent's route at spawn time"，实机 subagent 检查在 spawn 前切换父模型并断言子 agent 跟随（保留此前 "child routes within parent routes" 的断言）。

## 0.51.8

- 记录并断言了 **subagent 路由继承**：由非默认路由 session 生成的子 agent 在同一路由上消费（探针：父 `deepseek-account/deepseek-flash` → 子同路由），所以选择父模型即可影响其 agent 的花费。
- 两份 README 均如此说明，实机 subagent 检查断言子 agent 的 `byModel` 路由落在父路由集合内，验证矩阵记录了该探针。

## 0.51.7

- `docs/LIVE-VERIFICATION.md` 记录了一次完整清扫：一个启用搜索索引的 profile 在同一进程中跑完所有模式的 live-checks（`--with-model --with-subagent`，115/115）和完整验收运行（163/163），说明两套件对同一进程一致，而非各自单独通过；改动 desktop 组合前需重跑。

## 0.51.6

- 验收运行的 phase-receipt 检查现在交叉核对数字而不只是形状：某个 turn 的 `fromTurn`/`toTurn` receipt 必须等于同一报告中 `byTurn` 该行的总量，**并且**等于完整 receipt 中该 turn 的行。窗口化报告若悄悄折叠了错误事件，可通过形状检查但通不过此项。

## 0.51.5

- `tools/live-checks.mjs --with-model` 也交叉核对 token 数字：每条 prompt 回复的逐 turn `turn.usage.totalTokens` 必须等于 `session_usage` receipt 中对应行，且行之和等于 receipt 的 session 总量。
- 此前的路由核对说明**哪个**模型运行，这里说明计费数字在两个视图中一致。

## 0.51.4

- `tools/live-checks.mjs --with-model` 交叉核对同一批 turn 的两个视图：`session_usage { includeTurns }` 的行必须与每条 prompt 回复的 `turn.models` 报出相同路由，初始 turn 与切换后的 turn 都要成立。
- 计费与路由对"哪个模型运行"的说法不一致，正是单视图测试看不到的漂移。

## 0.51.3

- `tools/live-checks.mjs --with-model` 补齐了 catalog 闭环：在 `dsh_info` 实际公布的路由上创建 session、跑一个真实 turn、检查该 turn 报出该路由，若存在第二条路由则切换并检查下一个 turn 跟随。
- 单独检查 catalog 只能证明列表格式正确，这里证明 `session_create` 与 `session_set_model` 确实消费它。

## 0.51.2

- `tools/live-checks.mjs` 检查 `dsh_info` 中 catalog 的诚实性：每条路由是具名 id，每个按路由的模型列表格式正确且属于具名路由，无法读取的 catalog 记入 `catalog.unavailable` 而不是静默缺失，默认 agent preset（若存在）须是已列出的 preset 之一。
- 首次运行因本 profile 的 registry 只暴露 id 而误报了 presets，检查改为断言真实契约（`id` 必填，`name`/`description` 可选）而非想象的契约；82/82 廉价检查通过。

## 0.51.1

- `tools/live-checks.mjs` 真实演练了 compare-and-swap 的丢失更新窗口：客户端 A 读取哈希，B 改写文件，A 的带守卫写入被拒绝并返回新哈希、B 的内容保持完好，A 用当前哈希重试成功。
- 此前测试只覆盖单客户端情形，这里覆盖了守卫存在的意义——交错。

## 0.51.0

- `file_list { sha256: true }` 为每个文件内容计算哈希以便批量检测变更；超过 `limits.maxReadBytes` 或无法按文本读取的文件会带 `sha256Unavailable` 及原因，而不是静默省略，避免把不完整的视图当作完整结果。目录不带这两个字段，默认关闭。
- 首次实机运行哈希了 0 个文件，捕获了同类疏漏的**第三**例：schema 加了选项但 handler 未转发（此前是 0.46.0 的 turn 范围与 0.50.0 的读取哈希）。`tools/check-docs.mjs` 现有系统性守卫：解析每个 tool 的 `inputSchema` 与守卫体，选项未到达 `args.<name>` 即失败，通过注入合成死键（DRIFT）再移除来验证；重跑哈希 2 个文件并通过 163/163，两份 README 已更新。

## 0.50.0

- `file_read { sha256: true }` 返回**整个**文件（而非返回窗口）的 SHA-256，作为后续 `file_write`/`file_edit` 可携带的 compare-and-swap 值，读→决策→写的循环不再需要额外调用。因需读取整个文件，该选项为 opt-in，超过 `limits.maxReadBytes` 时拒绝；不传标志则不额外读取且字段缺失。
- 测试覆盖整文件与窗口哈希之差（哈希上限取配置限制而非窗口）、字段缺失和超限拒绝；验收运行将哈希与 `file_write` 返回的值比较并用于一次 CAS 编辑（162/162）。首次实机运行未返回哈希，暴露了与 0.46.0 同类的接线疏漏：新参数未被 tool handler 转发。两份 README 已更新。

## 0.49.0

- `file_write` 与 `file_edit` 接受 `expectedSha256`（compare-and-swap）并返回结果文件的 `sha256`：读取文件、决策再写回的外部 harness 不会再覆盖并发编辑，哈希不匹配时报出实际哈希且不写入任何内容。带 `expectedSha256` 的 `file_write` 拒绝创建不存在的文件（要创建则省略该字段）。
- 测试覆盖匹配写入、陈旧写入、文件缺失、匹配编辑与陈旧编辑；验收运行在磁盘上做了真实 CAS 往返，两份 README 已更新。

## 0.48.0

- `session_fork` 接受 `atTurn`：在该 turn 末尾切出子 session，而不是用原始事件 seq 表达——这是调用方计费与推理时的单位。回复回显解析后的 `atSeq` 与 `atTurn`；未知 turn 会列出日志记录的 turn，同时传 `atSeq` 和 `atTurn` 会被拒绝而非静默取其一。
- fork 测试覆盖解析、未知 turn 错误与互斥；验收运行在第 1 个 turn 处 fork 并检查子 session 继承的前缀，两份 README 已更新。

## 0.47.0

- `session_messages` 接受 `fromTurn`/`toTurn`：按 turn 范围读取长 transcript 的某个阶段，与 `session_usage` 现在提供的 `fromTurn`/`toTurn` receipt 对应。归属沿用既有规则——assistant 与 tool 行带 `turn`；用户 prompt 没有 turn 编号，不属于按 turn 归属的读取。
- driver 与 endpoint 测试覆盖该范围及其转发；验收运行将范围读取与精确 turn 读取比较（行相同），两份 README 已更新。

## 0.46.0

- `session_usage` 新增 `fromTurn`/`toTurn`：只折叠该闭区间内的 turn，调用方可为某个任务阶段（例如"评审开始后的那些 turn"）而非整个 session 计费。范围回显为 `turnRange`，totals/byModel/byTurn 只描述这些 turn，且与 `sinceSeq` 窗口一样，报告不做投影校验；反向范围会按闭区间规则被拒绝。
- fold 与 driver 测试覆盖子集总量、回显范围、单 turn 情形与反向范围拒绝；验收运行把最后一个 turn 作为单 turn 阶段计费（19 398 / 约 77 500 token）。首次实机运行返回了整个统计，暴露出新参数被接到了 `session_messages` 的 handler/schema 而非 `session_usage`，在发布前捕获并修复。两份 README 已更新。

## 0.45.0

- `session_usage` 新增 `sinceSeq`：从该事件 seq 起折叠每一行，用于长 session（或其中一段）的增量 receipt，而不必重读已计费的花费。窗口回显为 `sinceSeq`；`verifiedAgainstProjection` 为 false 且不输出 `projectionTotals`，因为 harness 投影覆盖整个日志，与窗口比较没有意义。起点早于某个 fork 的继承前缀时会被夹到该前缀。
- driver 测试覆盖全量与分段总量、回显窗口、逐 turn 子集与投影注意事项；验收运行将真实分段与全量统计对比，两份 README 已更新。

## 0.44.0

- 逐 turn 用量行现在还带 `models`：为该 turn 计费的 `provider/model` 路由（已排序），因此按轮次计费可以看出哪个模型花了 token（turn 中途切换路由正是裸总量所掩盖的）。若某 turn 的采样全为未归属的重试，则该字段缺失而非空列表。
- usage-fold 测试覆盖逐 turn 路由（含未归属情形）；验收运行断言真实 turn 报出自己的路由，两份 README 已更新。

## 0.43.0

- `session_usage { includeTurns: true }` 的逐 turn 行现在除 token 桶外还带 `durationMs`（从该 turn 的 start 事件到 end 事件），调用方可按 turn 计费并看出哪个 turn 慢。当日志在折叠窗口内缺少边界（继承前缀、仍在运行的 turn）时字段缺失，而不是猜测。
- usage-fold 测试覆盖已结束与仍在运行两种情形；验收运行断言真实 session 的已结束 turn 带时长，两份 README 已更新。

## 0.42.0

- `session_messages { includeToolResults: "errors" }` 只保留 harness 标记为失败的 tool result，定位某个 turn 出错的原因从扫遍所有结果变成一次读取。`true` 仍返回全部行，布尔形式保持不变。
- driver 测试覆盖该过滤；验收运行将返回的失败项与完整结果列表中的 error 标记对比，两份 README 都有说明。

## 0.41.0

- `session_messages` 的行在日志可归属时带 `turn` 与 `step`，且 `turn: N` 可把读取收窄到单个 turn。由于被日志归属的是 assistant 与 tool 行（事件上的 `turn`/`step`），按 turn 过滤读到的就是该 turn 自己的行；用户 prompt 没有 turn 编号，文档明确说明其被排除而非猜测。
- driver 与 endpoint 测试覆盖归属与过滤；验收运行断言真实 tool 行带 turn/step，且按 turn 过滤的读取不越出该 turn，两份 README 描述了这些字段。

## 0.40.0

- `session_messages` 新增 `includeToolResults`：每条记录的 `tool/result` 变成一行 `role: "tool"`，带 `callId`、`text`、`error`，并与其他消息一样受 `maxCharsPerMessage` 限制。`includeToolCalls` 说明调用了什么、结果多大，这个选项说明结果**说了什么**，一次读取即可重建完整时间线，不必把 `session_tool_result` 查询与 transcript 配对。默认关闭，因为一个结果可能与文件一样大。
- 由 driver、endpoint 测试与验收运行覆盖（真实 bash 结果以限长 tool 行出现）；两份 README 描述了该选项。

## 0.39.0

- `session_prompt` 的 turn receipt 现在带 `turn.durationMs`：从该 turn 的 start 事件到 end 事件的墙钟时间。token 说明一个 turn 花多少，这个字段说明调用方等了多久，超时或 SLO 正是据此调整。在等待边界处 turn 仍在运行时字段缺失（不给不诚实的时长），driver 测试固定了这两种情形。
- 首次验收运行未报出时长，暴露了一个值得知道的顺序细节：DSH 在用户消息**之前**提交 `turn/start`，所以 start 事件落在 transcript 窗口之外；摘要现在回溯到所属 turn 的 start，实机运行报出真实 turn（FizzBuzz 那个 turn 为 3 489 ms）。两份 README 都在 `session_prompt` 行提到该字段。

## 0.38.6

- `tools/live-checks.mjs` 检查 `dsh_info` 与其描述的表面一致：报告的版本等于本 checkout 的 package 版本（从而发现陈旧的已安装构建而不是静默验证通过），endpoint 回显与调用方到达的 URL 匹配，`toolAvailability` 正好列出已公布的 tool 并为每个不可用项给出原因，`enabledToolGroups` 与 `harnessServices` 是覆盖每组/每服务的布尔映射，health 报出运行时与实时 RSS 数值，生效的 session scope 被回显，注意事项以 notes 返回。

## 0.38.5

- `tools/live-checks.mjs` 检查 shell 截止时间与作业表：`shell_run` 在截止时间返回并带 `timedOut: true`（5 秒命令约 706 ms），快速命令返回输出且 `timedOut: false`，第 17 次启动会淘汰最旧的**已结束**作业并成功，而当 16 个作业都在**运行**时下一次启动被拒绝并给出 "does not silently stop" 说明。
- 两份 README 的表格现在都写明了保留规则。

## 0.38.4

- `tools/live-checks.mjs` 覆盖列表与图片限制：非递归列表只一层、递归能到嵌套文件，`maxDepth` 限制遍历深度，对文件做列表会给出可读错误，真实 1x1 PNG 以元数据文本块加 MCP image 块返回，文本文件被以 "not an image" 拒绝，路径缺失会说明，9 MiB 文件被拒绝并点名 8 MiB 上限。
- 两份 README 都提到图片之前的那段元数据块。

## 0.38.3

- `file_read` 的描述现在精确说明窗口切在字符中间时会发生什么：每个孤立字节解码为一个 U+FFFD（一个 3 字节字符提前一字节开始会产生两个），其余部分保持对齐——旧措辞暗示只有一个替换字符。
- 该问题由新的实机分页检查发现，该检查还断言被截断的读取报出 `truncated`/`bytes`/`nextOffset`，且下一个窗口能把文件按文本逐字节补齐。

## 0.38.2

- `tools/live-checks.mjs` 新增 prompt 输入章节：空 prompt 被拒绝并给出可接受的形式，非图片附件按名字被拒绝，图片超量在任何文件被读取之前就被拒绝，被拒绝的 prompt 绝不会被半接收（transcript 不增长）。
- 不消耗任何模型 turn。

## 0.38.1

- **修复了 `session_create` 中静默的模型选择处理。** 只给 `provider` 或只给 `model` 过去会在默认路由上创建 session 并把错误藏进日志（甚至可能把请求的 provider 与已配置的 model 配对）。schema 说明两者成对，因此半个配对现在会在 session 创建**之前**被拒绝。**profile 配置**中的半个配对仍会创建 session，但会报告 `modelSelectionError`，回复不再隐藏原因。
- tool 描述与两份 README 说明了该契约；driver 测试覆盖两种情形，live-checks 断言错误质量（半个配对、目录缺失、无法路由的配对仍创建 session 并给出路由说明、未知 preset）。

## 0.38.0

- `session_fork` 的描述（及两份 README）现在写明实机检查发现的前置条件：源 session 至少需要一个已完成的 turn。从未应答的 session 没有可分支的前缀，harness 以 "has no completed turn to fork from" 拒绝——表述准确但此前未文档化，调用方 fork 刚创建的 session 时会意外。
- 实机检查现在断言该拒绝可读；正向 fork 路径仍由验收与 smoke 运行覆盖（它们 fork 已应答的 session）。`tools/live-checks.mjs` 新增 fork/rename 章节：标题以去空白形式存储并经 `session_list` 返回，未知 session id 是可读错误，空标题在到达 harness 之前被拒绝。

## 0.37.14

- `tools/live-checks.mjs` 检查 `dsh_tool_list`/`dsh_tool_call` 的承诺：列表对某个 session 是真实的（此处 15 个 agent tool），未列出的名字被拒绝并给出 `agentTools.allow` 提示，已列出但参数为空的 tool 以该 tool 自身的校验消息失败而不是传输层错误，30 KB 的 `bash` 结果返回时被 `maxResultChars` 截断并带 `truncated`、`resultBytes` 且无 `value`。

## 0.37.13

- `tools/live-checks.mjs` 检查 workspace 的承诺：同一路径只注册一次（返回已有 id），`workspace_list` 报出路径/session 数量/是否存在，`workspace_delete` 只删除注册而保留目录与文件不动，未知 id 返回 `deleted: false` 而不失败，`createDirectory: false` 时拒绝缺失目录且不创建它。

## 0.37.12

- `tools/live-checks.mjs` 检查最容易出错的文件 tool 承诺：有歧义的 `oldText` 被拒绝且**不写入任何内容**，`replaceAll` 替换每一处出现，`createDirectories: false` 在创建父目录之前就失败，相对路径在读与写上同样按 `cwd` 解析。
- 廉价章节，不消耗模型 turn。

## 0.37.11

- **修复了永远不可能为 true 的 `shell_output.lossy`。** `drainShellJob` 只把 shell 服务的数据丢失记为 `truncated`，从未设置 `job.lossy`，因此当一个作业的字节已被服务丢弃时，取回一页会报 `truncated: true, lossy: false`——正是该字段要避免的含混回执。
- 由新的保留检查发现：一个写入 200 KiB 的作业只返回一个 64 KiB 页，且无法判断其余部分为何缺失。标志现在会被持久化，回归测试覆盖它，实机检查要求该情形下两个标志同时出现。

## 0.37.10

- `tools/live-checks.mjs` 检查后台 shell 的保留承诺：一次写入 200 KiB 的作业返回时必须被限制在保留的 128 KiB 缓冲区内、报出 `truncated` 并能读完；无界或静默丢数据的作业会使检查失败。
- 廉价章节，不消耗模型 turn。

## 0.37.9

- `tools/live-checks.mjs --with-model` 现在检查 `session_cancel` 所声称的 "queued work is preserved"：它在一个长 turn 之后排入第二条消息，取消该 turn，并断言该消息仍处于 pending 且随后执行。
- 同章节中被撤回的消息仍必须从未执行。

## 0.37.8

- `initialize` 指令现在覆盖其成文之后新增的表面：规划序列前先看 `toolAvailability`、检查三件套（`includeToolCalls` / `session_tool_result` / `session_list origin`）、`session_search` 及其 opt-in 索引，以及 `session_queue`/`session_cancel` 与 `session.scope: "owned"` 的注意事项。
- 只讲到前三个 tool 就结束的指令会让其余部分无人发现；endpoint 测试现在断言这些短语存在。

## 0.37.7

- `session_messages` 的用户消息现在带准入 `requestId`（与 `idempotencyKey` 派生、日志记为 `source.rpcId` 的是同一个 id）。调用方可以把自己的 prompt 与重试和 transcript 条目对应起来，而不靠文本匹配；验收运行检查被等待那条 prompt 的 id。

## 0.37.6

- **修复了幂等重试中真实的重复发送竞态。** `wait: false` 在 `controller.prompt()` 解析时返回，但持久化的用户消息可能稍后才提交；在该窗口内重试找不到自己的日志条目，会让 agent 把工作做两遍。验收检查 "queue then await" 将其捕获为两条携带相同 `rpcId` 的用户消息。
- driver 现在保留一个小型内存准入台账（有界，24 h / 200 keys），在日志尚未跟上时作为回退；重启后的重试仍走日志路径。回归测试延迟提交并断言重试改为等待而非重发。

## 0.37.5

- 记录并验证了等待排队工作的预期方式：以 `wait: false` 加 `idempotencyKey` 排入 prompt，然后用同一 key 与 `wait: true` 再次调用，重试会重放该准入并**等待**该 turn，而不是发送第二条 prompt。
- tool 描述与两份 README 均如此说明，driver 测试覆盖 pending turn 的重放，验收运行检查回复以及 transcript 中只存在一条这样的用户 prompt。

## 0.37.4

- `tools/live-checks.mjs --with-model` 新增编排章节：用 `wait: false` 启动长 turn，在其后排队工作，列出并撤回该排队消息，取消运行中的 turn，然后再次向 session 发起 prompt。
- 每个 tool 单独存在都已成立，这里断言它们能在同一 session 上组合而不破坏状态（后续 prompt 得到应答，被撤回的消息从未执行）。

## 0.37.3

- `tools/live-checks.mjs --with-model` 还会在两个独立 session 上同时跑两个真实 turn，并断言各自应答了自己的 prompt、互不中止、各自 transcript 保留自己的对话（对应关系错乱会表现为 transcript 中出现另一个 session 的标记）。
- 串行化是按 session 的，驱动多个任务的 harness 依赖这一点。

## 0.37.2

- `tools/live-checks.mjs` 新增并发章节：20 个并行 `dsh_info` 调用必须都报出同一版本，8 个并行文件写后读必须保持一致，12 个并行 `session_list` 调用必须对总数一致。
- 这不是基准测试，而是断言共享 session 与共享文件路径在并行调用下不会退化为失败——外部 harness 或 agent 团队实际就是这样驱动 endpoint 的。

## 0.37.1

- `session_tool_result` 新增 `from: "end"`：当结果超过 `maxChars` 时保留尾部而非头部，栈回溯或结尾错误正在那里。回复回显 `from: "end"`，调用方可判断自己拿到的是哪一端，代理对不会被拆开。
- 验收将尾部与完整结果的末尾字符比较，driver 测试覆盖该裁剪。

## 0.37.0

- `session_tool_result` 现在除 `callId` 外也可用 `toolName` 定位结果：返回该 tool 最近一次完成的调用并给出解析到的 call id。观察 session 的调用方通常知道 "the last bash result is what I need" 而不必跟踪 id。
- 未知名字会列出确有记录调用的 tool，同时传两个选择器（或都不传）会被拒绝；由 driver 测试与验收运行覆盖（按 id 与按名获取真实 bash 结果），两份 README 已更新。

## 0.36.1

- `tools/live-checks.mjs --with-subagent` 也端到端演练调试路径：用 `includeToolCalls` 读取 subagent 的 transcript，取一个已完成的 call id，用 `session_tool_result` 取回该结果，并检查返回长度等于 transcript 的 `resultChars`。
- 子 agent 未发起调用时会干净地跳过。

## 0.36.0

- **`session_tool_result`**（第 28 个 tool）：按 call id 读取一条已记录的 tool 结果——文本、原始长度、harness 是否标记为错误、以及 `maxChars` 上限。`includeToolCalls` 已说明结果多大，这个 tool 是针对失败本身的定向跟进，无需重读长 transcript。
- call id 来自 transcript，因此查询有界且限定在单次调用；可用性映射、两份 README 的 tool 表格、能力审计与验收脚本的预期 tool 列表均已更新，演练现在按 id 取回真实 bash 结果并与 transcript 的 `resultChars` 对比长度。

## 0.35.0

- 当命中的 session 是 agent 子 session 时，`session_search` 的结果现在带 `parentSessionId` 与 `origin: "subagent"`，数据来自 enrichment 已执行的同一次列表查询。搜索结果因此能说明它在树中的位置，而不只是属于哪个 workspace、有多新。
- 用真实 subagent 并开启搜索索引验证（live-checks --with-subagent）：子 agent 的 "SUBAGENT-OK" 命中带出了它的父 session。

## 0.34.0

- `session_list` 新增 `origin` 过滤（`root` | `subagent`），在应用 limit 之前生效，因此 `total` 仍然诚实。配合父系字段，树视图到此完整："我启动过哪些 session"与"哪些是我 agent 的子 session"，无需读取 transcript。
- 用真实 spawn 的 subagent 实机验证：`origin: "subagent"` 只返回子 session，`origin: "root"` 只返回父 session（live-checks --with-subagent）。

## 0.33.0

- `session_list` 暴露父系关系：subagent session 带 `parentSessionId` 与 `origin: "subagent"`，调用方可以从扁平列表重建 agent 树而无需逐个读取 transcript。字段来自该调用本就执行的同一次 session 列表，没有额外读取。
- 用真实 spawn 的 subagent 实机验证：子行给出了父 session 与 origin，根行两者都不带（live-checks --with-subagent）。

## 0.32.1

- `session_messages { includeToolCalls: true }` 现在还会在结果存在后报出每次调用的结果状态：`resultChars`（文本结果长度）以及 harness 标记为错误的 `error`。尚未应答的调用两者都不带，轮询方据此区分 "still running" 与 "done"。
- 结果在一次日志遍历中按 call id 对应，因此读取仍是 O(events)，参数与结果只被度量而不会被重复返回。

## 0.32.0

- `session_messages` 新增 `includeToolCalls`：每条 assistant 消息随之携带模型请求的 tool 调用（名称、call id、参数 JSON 长度）。仅有文本只能说明 "I'll run it"，调用列表才让对运行中 session 的轮询可操作，且因为参数只被度量而非重复，返回保持有界。
- 首次验收运行以 0 次调用失败，暴露了一个真实 bug：只请求 tool 的模型消息没有文本，而 transcript 循环此前会丢弃无文本消息，导致纯 tool 调用步骤从不出现。带 `includeToolCalls` 时这类消息现在被保留（空文本、附上调用），不带时历史散文式 transcript 不变；driver 回归测试覆盖，验收运行现在能看到 4 次调用。

## 0.31.2

- `tools/live-checks.mjs` 现在可用于更旧的部署：每项检查都先以端点自己的 `tools/list` 为准，缺少 `shell_start` 或 `session_search` 的构建会把对应小节标记为 `skipped`，`--old-endpoint` 也会把契约不匹配转成 `skip`。
- 对桌面应用的 0.2.0 构建运行时，它报告 3 项协议检查通过、4 项 `skip`（Bearer challenge、`total`/`truncated`、分页元数据和 workspace 作用域用量），这正是该构建尚不支持的契约清单。
- 对当前构建的严格运行通过 16/16，说明这种前置判断没有掩盖真实回归。

## 0.31.1

- `dsh_info.toolAvailability` 现在还会列出通过检查的工具（`availableTools`），调用方可以拿它与 `tools/list` 对比，而不必只信任数量。
- 两者是同一集合：被禁用的组在两边都不出现，组已启用但缺少服务的工具只出现在 `unavailable` 中，`tools/live-checks.mjs` 现在会在运行时断言这一点（跳过没有该字段的旧端点）。
- 单元测试与端点测试覆盖了这个新列表，数量与列表长度一致。

## 0.31.0

- `dsh_info` 现在报告 **`toolAvailability`**：对每个对外声明的工具说明本部署能否提供它，不能时给出具体原因（工具组被禁用，或缺少服务，例如没有 `updateQueue` 的 `session_queue`、缺少 `start()`/`execute()` 句柄的后台 shell 工具、缺少 `agents` 的 `dsh_tool_*`）。
- 依赖映射放在 `src/mcp/availability.ts` 中与它所用的探测相邻，因此不会与能力名脱节，并为每条规则和说明做了单元测试。
- 原有的 `harnessServices` 布尔值不变；这是给调用方做调用前预检的辅助信息，不是授权层。

## 0.30.9

- `tools/check-docs.mjs` 现在检查设置面板的本地化：zh 与 en 词典的键集合必须一致，面板引用的每个键都必须在两边存在，未被引用的"死"键会被列出。
- 编写过程中发现并修复了两个解析缺陷：zh 扫描吞掉了 en 块从而掩盖了一个缺失的 zh 键，运行时拼接的键（`client.tokenSource.${source}`、`state.*`）未被计入引用。
- 从两个词典中删除了三个真正的死键（`field.approval.policy.allow.hint`、`field.auth.token.replace`、`client.statusLabel`）；反向测试中删掉一个 zh 键或拼错字段标签都会让检查以 1 退出。

## 0.30.8

- `tools/check-docs.mjs` 现在检查发布声明：变更日志标题必须唯一且严格从新到旧，`docs/LIVE-VERIFICATION.md` 引用的每个版本都必须有对应的变更日志条目，`docs/CAPABILITY-GAPS.md` 中重述的工具数量必须等于代码注册的数量。
- 它发现了一处真实漂移：验证记录引用了 `0.1.0`，而它早于变更日志（最旧条目是 0.2.0），两行现在都写成 "≤0.2.0 (first documented release)"；用伪造的 9.9.9 引用做了反向测试，检查以 1 退出并指出该版本。

## 0.30.7

- `tools/check-docs.mjs` 现在也检查配置：每份 README 的 YAML 示例必须恰好设置 `normalizeConfig` 接受的键（去掉可选的 `auth.token`），设置面板必须为其中每个键提供字段，且不为未知键提供字段。
- 编写过程中暴露出并修复了两个解析缺陷（根级 `config` 守卫被当成小节读取，小节／面板正则只接受小写名导致 `agentTools` 看起来缺失）；反向测试中从示例删除 `session.scope` 会让检查以 1 退出并指出它。

## 0.30.6

- 新增了 `tools/check-docs.mjs` 以及 `tools/release.sh` 中的 `docs consistency` 步骤，用于比对两份 README 的工具表与代码注册的工具、包版本与最新变更日志标题、随包 `files` 列表与磁盘实际内容（以及维护者专用目录）、以及 README 引用的每个 `docs/*.md` 与脚本路径。
- 它立刻发现文字审阅漏掉的真实漂移：en 工具表缺少 `session_queue`（该行编辑静默未生效），zh 表只有 24 行、重复了 `session_create` 且缺少七个工具（`workspace_delete`、`file_edit`、`file_read_image`、`shell_start`、`shell_output`、`shell_kill`、`shell_list`）；两张表现在都列出全部 27 个，并做了反向测试。

## 0.30.5

- `tools/release.sh` 新增 `--acceptance`：在临时 `DSH_HOME` 下启动一次性 profile（由系统选择空闲端口、隔离会话存储，并把运维者的 provider 凭据复制进 0700 目录以便真实轮次可用），对它运行完整验收脚本，再通过 EXIT trap 清理全部内容。
- 实测验证：142/142 项检查通过，cwd 运行正常，没有残留 profile、进程或 `/tmp` 目录。

## 0.30.4

- 新增 `tools/release.sh`：把发布清单变成可执行流程（两套 typecheck、测试、两个 bundle、pack、断言 tarball 不含维护者专用目录、可选的 `--live` 检查、可选的带回滚目录的桌面安装）。
- 它拒绝重新安装桌面 profile 中已存在的同一版本，因为 pnpm 会把同一 `tarball` 路径当作已安装，这个陷阱曾让重建后的插件看似已安装而实际仍跑旧构建。

## 0.30.3

- 在真实 harness 上核验了最后一项未结的计费问题：agent 启动子代理后，`session_usage { includeSubagents: true }` 把它作为独立行返回（父 27,419 tokens、子代理 18,567），报告总量等于两者之和；在 `session.scope: "owned"` 下该子代理会话被列入、计费并可读取为 owned 树的一部分。
- `tools/live-checks.mjs` 新增 `--with-subagent`，使该检查可复现而不再是一次性探测：它启动一个 helper，断言回复、子代理行、总量恒等式和树访问（开启模型检查时 23/23）；桌面组合仍是唯一未验证路径。

## 0.30.2

- `session.scope: "owned"` 现在把 **owned 会话下的子代理会话**视为 owned 树的一部分：列出、搜索、按 id 读取用量和读取 transcript 都接受祖先由本端点创建的子会话，同时仍拒绝树外内容，因为排除子代理会让 owned 会话的账单和列表静默漏掉它引发的工作。
- 该树每次调用时从会话列表中解析一次（不按行额外读取），列表失败时按失败关闭处理；`cancelSession` 变为 async 以便做可见性检查，其工具处理器会 await 它，原本返回裸 `{accepted:true}` 的回复保持不变。

## 0.30.1

- `session.scope: "owned"` 现在记住自己创建过什么：新建和 fork 的会话 id 写入 `$DSH_HOME/dsh-as-mcp/owned.json`（`0600`、目录 `0700`、最多 1000 个 id、tmp 加 rename 原子写入），因此归属能跨插件重载或 DSH 重启保留，而不是只存活一个进程。
- 记录缺失或损坏时读作"没有任何会话被拥有"，按失败关闭处理，只会隐藏会话；测试现在跑在自己的临时 `DSH_HOME` 下，套件运行不会再写入开发者的真实 `~/.dsh`。

## 0.30.0

- 新增 **`session.scope`**（`all` | `owned`，默认 `all`）：安全审计 F4/F11 要求的收窄选项，且不改变默认行为。在 `owned` 下，所有承载内容的会话工具（prompt/steer、cancel、list、transcript、fork、rename、set-model、queue 的列出与变更、search）都限制在本端点创建或 fork 的会话内，拒绝时会指出该设置。
- 搜索改为过滤匹配并报告 `hidden` 而不直接失败；`session_usage` 拒绝显式的外部 id 并在聚合作用域中说明被排除的行；`session_list` 先过滤再取 limit，因此 `total` 仍然诚实；该选项在设置面板和两份 README 中公开。
- 已记录两个失败关闭的后果：归属按插件进程计（重启前的会话不再算 owned），搜索是在 harness 全局 20 条结果返回后再过滤；在 `scope: owned` 的 profile 上实测通过，且验收在该作用域下通过 142/142。

## 0.29.3

- 安全审计补齐了它写完之后新增的工具：第三轮评审把两个已接受的后果而非问题记录为 **F11**（`prompt`/`steer`、`cancel`、`rename`、`set_model`、`fork`、`session_queue` 等会话变更是实例级范围，持 token 者可改动非自己创建的会话）和 **F12**（`session_search` 会披露每个可见会话的有界片段，因此搜索在部署级是可选开启，`dsh_info { probeSearch: true }` 会报告其状态）。
- 两份 README 的安全章节现在都说明这种触及不止于读取；另记录了一个未实测的场景：撤回由*另一个*客户端排队的消息。

## 0.29.2

- 新增 `docs/LIVE-VERIFICATION.md`：记录哪些行为已在真实 harness 上核验、每项随哪个版本发布、如何复现该检查，并附明确的"此处未验证"清单（桌面组合下的子代理计费待应用重启、面板视觉、分块请求体边界、一次实际观察到的沙箱拒绝）及原因。
- 两份 README 都链接它；其中的版本是与本变更日志核对过的，而非凭记忆写出。

## 0.29.1

- 在真实 harness 上核验了 `session_queue` 另外两个动作并记录了语义：`edit` 保留排队消息的 id（调用方可继续使用它列出的 id），`steer` 确实进入正在运行的轮次——被 steer 的文本作为用户消息出现在 transcript 中，助手回复紧随其后（`STEERED-ACCEPTED`），该轮次先前的工作保持完好。
- 无运行时改动。

## 0.29.0

- 新增 **`session_queue`**（第 27 个工具）：编辑、撤回或 steer 一条*待处理*的排队消息，通过 `session_messages` 现在携带的消息 id 定位；用 `wait: false` 排入工作的调用方可以在它消耗轮次之前撤回。
- `session_cancel` 停止正在运行的轮次，而它改变的是排在其后的工作；只传 `sessionId` 时它从实时 `inbox` 投影列出待处理收件箱，这是排队消息在轮次开始前唯一存在的地方。
- 该能力在 `dsh_info.harnessServices` 中报告为 `sessionQueue`。

## 0.28.0

- `session_messages` 新增 `beforeSeq`：超过 500 条消息窗口的 transcript 现在可以向后分页读取，传入你手上最旧消息的 seq 就会返回更旧窗口的尾部，重复调用可走完整份日志而无需服务端游标。
- `total` 仍统计过滤器匹配到的全部消息，因此调用方可以知道还能往前翻多少。

## 0.27.0

- `dsh_info { probeSearch: true }` 现在回答"此处会话搜索是否真的可用"，而不只是"控制器是否暴露搜索"：它会跑一次随机 token 搜索（匹配不到任何内容），从而把被禁用的索引报告为 `search.available: false` 并给出启用说明。
- 该探测为可选开启，因为首次搜索可能会打开并重建索引；`tools/live-checks.mjs` 使用该探测并针对启用与禁用的部署都断言 `session_search` 与它一致。

## 0.26.0

- `session_search` 的命中项现在带上下文：`cwd`、`updatedAt` 和 `running` 来自同一次会话列表读取，调用方不必再发一次请求就能知道匹配来自哪个 workspace、有多新。
- 会话列表读取失败不会让搜索失败——匹配项仍会返回，只是不带这些上下文。

## 0.25.1

- 两份 README 都新增 **Deployment requirements** 章节：一张表说明每个工具组需要什么（服务，以及该能力可在哪里配置，如 `session-query` 的 `openAt`、`costMeter`、`approval`、`webServer`），运维者无需读源码即可知道某工具为何不可用。
- `tools/live-checks.mjs` 现在也检查会话搜索，并接受两种合法部署（新 token 在索引打开时返回无匹配，索引被禁用时报告如何启用）；在两种部署（stock profile 与 `openAt: first-search`）上实测各通过 11/11。

## 0.25.0

- 新增 **`session_search`**（第 26 个工具）：对会话*消息内容*做字面搜索，每处匹配返回 `sessionId` 加一段摘录，以 20 条为界并提供 `hasMore`。
- 它回答"哪个对话讨论过这个"，无需列出、读取再 grep transcript；依赖 `sessionController.search`，该能力在 `dsh_info.harnessServices` 中报告为 `sessionSearch`。

## 0.24.3

- 新增 `tools/live-checks.mjs`（仅维护者使用，不随发布包分发）：一次可复用的实机验证运行，覆盖协议契约、列表与分页契约，并在 `--with-model` 时覆盖进度流式与 MCP 取消。
- 对真实的 0.24.2 实例验证：廉价检查 10/10，加模型检查后 16/16（进度通知约每秒到达一次；一次取消在 12 ms 内结束等待并带 `turn.aborted: true`）。

## 0.24.2

- 针对 0.11.0–0.24.1 各轮已核验内容做文档一致性审计：CAPABILITY-GAPS 现在记录这些发现（有界回复、用量回执选项、列表契约、`workspace_delete`、`approval.policy` 实现、协议与取消工作、`mountOnWebServer` 修复），其服务探测表列出真实的二十项探测。
- 它"插件无法触达会话的 agent"这一结论被标记为已由 `resolveAgent` 解决，README 与 README.zh 的取消与 `partial` 表述与实测行为一致，zh 设计说明补上了 en 已有的取消相关那句。

## 0.24.1

- 在同一批协议行为上核验了 web-server 挂载：`enabled: false, mountOnWebServer: true` 时唯一监听者是 DSH 自己的，进度通知约每秒流式一次（而不是在末尾批量发送）。
- 取消通知到达 11 ms 后等待即结束，带 `turn.aborted: true`，且会话仍可用。

## 0.24.0

- **MCP `notifications/cancelled` 现在生效。** 所用 SDK 版本只接收该通知而不作处理，因此被取消的 `session_prompt` 过去会一直等到轮次结束；端点现在自己读取 JSON 请求体（通过 `parsedBody` 交给 transport），把在途 `session_prompt` 请求 id 映射到对应会话，并在匹配的取消到达时取消该轮次，等待中的调用以 `aborted`/`partial` 结束。
- 同一层对无法解析的请求体返回 JSON-RPC `-32700` 解析错误，并保留对声明超过 64 MiB 请求体的拒绝。

## 0.23.2

- 端到端核验了设置面板的实时写入链路（通过一个调用 `ctx.settings.update` 的一次性插件走同一条路径）：写入无需重启即落到合成配置中，`dsh_info` 报告了新的 `limits.maxReadBytes`，紧接着的 `file_read` 即被它限制（2048 而非此前的 1 MiB）。
- 同时确认受限读取的 `file_read` 分页元数据完整：`offset`、返回的 `bytes`、续读用 `nextOffset` 和整个文件的 `size` 都在，因此被截断的默认读取仍可继续。

## 0.23.1

- 实测（而非仅单元测试）确认工具组开关端到端生效：workspace/files/shell/agentTools/usage 全关时，`tools/list` 只公布 `dsh_info` 加会话组（9 个工具），调用被禁用工具返回 JSON-RPC `-32602 Tool ... not found` 而不是先运行再被拒，`dsh_info` 报告各开关状态，且 `session_prompt` 回复干净地省略 `session`/`usage` 块（不触发 `usageUnavailable`）。
- 新增一个逐个禁用各组的测试，断言只有该组的工具离开 `tools/list` 而其他组都保留。

## 0.23.0

- `session_usage { cwd }` 汇总在同一个 workspace 目录（规范化后）中运行过的所有会话，按最新优先并以 `limit` 为界；子代理行像其他作用域一样折算进来，空目录会在 `notes` 中说明，与 id 选择器混用会被拒绝。
- 这是用一次调用回答"这个项目花了多少"，而不必先列会话再逐个批处理。

## 0.22.0

- `shell_list` 新增 `running` 过滤器（`true` 只列在运行的任务，`false` 只列已结束的任务）；已结束任务会留在列表中直到新的启动清理它们，因此轮询单个长期会话的调用方过去得自己过滤这一页。
- 先做了实测：16 个任务的上限会以明确消息拒绝第 17 次启动，而不是静默驱逐正在运行的任务；输出超过 128 KiB 缓冲的任务会报告 `truncated`/`lossy` 以及溢出文件路径，而不是静默丢字节。

## 0.21.4

- 实测核验了 steer 与 queue 语义：在运行中的轮次里发送 `mode: "steer"` 消息会被并入该轮（仍是一轮，用量覆盖整轮），而 `mode: "queue"` 会成为下一个轮次。
- 文档现在明确说明不同会话之间不做串行化（实测两个各自被 4 秒工具步骤阻塞的 prompt 并发耗时 6.3 s），取消一个会话不会影响另一个；并补上了按会话串行化的缺失单元测试（第一个等待结束前第二个 prompt 根本不会提交）。

## 0.21.3

- 实测核验超时边界：`shell_run` 返回 `timedOut: true` 并发送 SIGTERM，shell 仍可用；`session_prompt` 的等待超时返回 `timedOut`/`partial`，而轮次继续运行、会话仍可用且最终用量会结算；`dsh_tool_call` 用较小的 `timeoutMs` 会中止该调用且会话仍可用。
- agent 工具中止现在会指出是哪个截止时间：harness 把客户端取消和我们的超时都报成 "tool call aborted"，所以回复改为 "aborted after <N>ms because timeoutMs elapsed"。

## 0.21.2

- 在刻意降级的 profile（workspace 与 session-controller 行被禁用）上验证插件：每个缺服务的工具都指出所需服务及提供它的 bundle，而 `file_read`、`shell_run` 和 `dsh_info` 继续可用。
- 修复了一处死路：没有会话列表时，空用量报告会建议调用方试 `all: true`，而那里根本无法工作；现在改为建议传入已知的 sessionId。

## 0.21.1

- `session_messages` 现在报告 `total`（被 `sinceSeq`/`role` 匹配到的消息数）以及当最新 `limit` 条窗口隐藏了更旧消息时的 `truncated`。
- 与 `session_list` 一样，此前回复无法告诉调用方它是从对话开头看起还是只看到尾部。

## 0.21.0

- `session_list` 现在报告 `total`（limit 之前的匹配数）以及 limit 隐藏了部分结果时的 `truncated`。
- 仅有列表无法区分"这些是我的全部会话"和"它们的第一页"，而这对在行动前扫描自己会话的调用方很重要。

## 0.20.7

- 验收覆盖更多文件系统与 shell 边界，且都先经实测：`maxBytes` 读取报告 `truncated`/`nextOffset`；符号链接环会被列出但从不跟随（递归进去的遍历永不结束）；`file_read_image` 依据字节而非扩展名嗅探格式；`shell_output` 不重复投递已读取过的输出。

## 0.20.6

- 401 响应现在携带 `WWW-Authenticate: Bearer realm="dsh-as-mcp"`；没有该质询，标准 MCP 客户端无法判断出示 bearer token 就是解决办法，只会把端点报成不可用而不重试。
- 验收新增协议契约检查（畸形 JSON 得到解析错误、未知方法得到 method-not-found、缺 token 得到 Bearer 质询、声明超大请求体得到 413）以及模型选择失败检查（错误路由会按名称报出并附已知路由与发现提示）。

## 0.20.5

- **修复了 `http.mountOnWebServer: true` 在真实安装上实际未挂载任何东西的问题。** DSH web-server 服务在使用它的插件之后才挂载，而代码只在启动时采样一次，导致路由从未注册、请求落到 SPA 回退并返回 405。
- 插件现在等待该服务（`internal/service`）并在其出现后立即挂载；仍在等待期间 `dsh_info` 会报告 `mountNote`。

## 0.20.4

- 当报告中任一包含的行是在轮次中途读取时，`session_usage` 现在也在报告本身携带 `partial: true`，并附注说明总量仍会增长。
- 此前只有单个行被标记，因此读取 `totals` 的调用方可能把快照当成最终账单。

## 0.20.3

- 仅文档与测试。记录并验证了重启后的连续性：DSH 重启前创建的会话仍可读取，`session_usage { sessionId }` 返回相同总量，`session_prompt` 可继续该会话且用量跨两个进程累计；只有基于归属的默认值会重置。
- 新增一个回归测试，确保拥有会话从不阻塞 prompt 或受限作用域的用量读取。

## 0.20.2

- 对以文件形式存在的路径调用 `workspace_create` 现在提示 "exists but is not a directory"，而不是回显 mkdir 的 `EEXIST` 系统调用消息。
- 验收脚本新增错误路径小节：未知会话 id 与任务 id、缺失文件、把文件注册为 workspace、对空会话 fork、未知 id 的用量回执（行内错误加总量排除），最后读取一次健康状态以证明端点经受住了这一连串错误。

## 0.20.1

- 设置面板：超时字段原本提供最小值 `0`，而被宿主校验器拒绝，现在从 `1` 起；新增测试确保每个面板字段路径指向真实配置叶子节点，且数值边界从不提供宿主会拒绝的取值。

## 0.20.0

- `session_prompt` 回复携带 `turn.models`：回答该轮次的 `provider/model` 路由（去重、按首次出现顺序），调用方无需读取 token 桶即可确认是哪个模型跑的。
- 声明请求体超过 64 MiB 的请求在读取请求体之前就被以 `413` 拒绝（纵深防御；携带大负载的工具另有自己的上限）。

## 0.19.1

- 仅文档与元数据。新增了本变更日志，无运行时改动。

## 0.19.0

- 新增 **`workspace_delete`**（第 25 个工具）：注销一个 workspace，但不触碰其文件或会话历史；幂等（未知 id 返回 `deleted: false`）。

## 0.18.0

- `session_list` 新增 `cwd`（规范化后）与 `running` 过滤器，且在 limit 之前应用，因此"我最近的 N 个"确实就是这个含义。
- `session_usage` 新增 `sessionIds`，可对多个已知会话出一份回执：重复项折叠、子代理按 id 折算，与 `sessionId`/`all` 混用会被拒绝。

## 0.17.0

- `session_messages` 新增 `maxCharsPerMessage`；被截断的消息报告 `truncated` 及其原始 `chars`。
- `session_prompt` 新增 `maxReplyChars`；被截断的回复报告 `replyTruncated` 及其原始 `replyChars`，`TurnResult.replyChars` 始终存在；两个上限都是可选开启，默认行为不变。

## 0.16.0

- `dsh_tool_call` 现在限制结果文本：默认 20 000 字符，`maxResultChars` 最大 200 000；回复始终携带 `resultBytes`，被截断时置 `truncated` 并丢弃结构化 `value`，因为 agent 工具可能返回整个文件。

## 0.15.1

- `dsh_info.harnessServices` 现在报告 `approval`、`sessionRename` 和 `sessionModel`，调用方可以区分"不可用"与"被拒绝"。
- 文档审计：修正了 `approval.policy` 的描述，在安全章节补充图像与后台 shell 说明，记录了轮次中途的 `partial`，并修正了"当前 harness 拒绝 `dsh plugin --profile desktop add`"的说法（它可用，只有受管操作会被拒绝）。

## 0.15.0

- **`approval.policy: "allow"` 现在真正实现**（此前有文档和解析但从未生效）：本插件创建的会话以及 fork 出的子会话会通过审批服务切换为 harness 的无人值守姿态。
- 创建／fork 的回复报告 `approvalPolicy: "never"` 或 `approvalPolicyError`。

## 0.14.2

- 元数据与导出：包描述反映真实工具面，自 0.2.0 以来新增的公开 driver 类型从包根导出。

## 0.14.1

- 验收脚本修复：跨小节的状态被块级作用域限制，导致运行抛出 `usageReported is not defined` 且从未到达后续小节；fork 检查读错了回复字段。两者均已修复并加了回归测试。

## 0.14.0

- 当会话最新轮次仍在运行时，`session_usage`（以及每次用量读取）会把报告标记为 `partial: true`，因此进行中的读取不会被误当作最终账单。

## 0.13.0

- 结构化输出：六个数据工具声明了 `outputSchema`，每个对象形式的回复在文本块旁边还会携带 `structuredContent`。

## 0.12.0

- `session_prompt` 新增 `idempotencyKey`：重试的调用返回已有轮次而不是把任务发两次（实测：0 额外 token，一条用户消息）；用相同键提交不同内容会被拒绝。

## 0.11.0

- 新增 **`session_set_model`**：为后续轮次切换会话的 provider 路由／模型；按模型的用量显示各路由分别花了多少。
- 共享且可操作的模型选择失败信息（请求的组合、已知路由、如何列出模型）。

## 0.10.0

- 新增 **`session_rename`**：显式的用户标题，在 DSH UI 中可见，并可通过 `session_list { includeTitle }` 读回。
- `dsh_info` 新增脱敏的 `config`（limits、approval、默认值，绝不含 token）与端点 `health`（node、平台、内存）。

## 0.9.0

- `session_prompt` 中的工具调用默认只做摘要（`name`、`callId`、`argumentsBytes`），不再回显完整参数；`toolCalls: full|none` 和 `maxArgumentChars` 控制详细程度。
- 实测：一次 5.8 KB 的 `write` 调用不再出现在回复里。

## 0.8.0

- `session_prompt` 接受最多四张图片（`png`/`jpeg`/`webp`/`gif`），通过文件系统接缝读取并作为 prompt 附件传给 agent。
- 客户端中止现在会让等待中的 `session_prompt` 以 `aborted`/`partial` 结束，而不是一直跑到超时。

## 0.7.0

- 新增 **`file_read_image`**：图片以 MCP image block 返回，格式由字节嗅探，上限 8 MiB。
- `dsh_info { includeModels: true }` 列出每个 provider 路由对外声明的模型，并对每个 provider 做时间限制。

## 0.6.0

- 新增 **`session_fork`**：在精确的事件前缀处分支会话；继承来的前缀由 `session_usage` 单独报告。
- 使用控制器的 fork（可冷读、会持久化子会话）；存储层的 fork 在实测显示其子会话无法被 prompt 后被弃用。

## 0.5.0

- **修复一个实机缺陷**：`shell_run` 在 harness 0.2.1 上以 "Cannot read properties of undefined (reading 'text')" 失败，因为 `execute()` 解析出的运行中进程句柄其前台结果要由 `result()` 取得。
- 新增 **`shell_start` / `shell_output` / `shell_kill` / `shell_list`**：后台命令，带有界缓冲与看门狗，并同时支持 0.1.5（`start`）和 0.1.7+（`execute`）两种 shell 形态。

## 0.4.0

- 当客户端提供 `progressToken` 时，`session_prompt` 会上报 `notifications/progress`（最多每秒一次）。
- `session_list { includeTitle }` 会折算每个会话的最新标题。

## 0.3.0

- 新增 **`file_edit`**：精确字面替换，除非 `replaceAll` 否则要求唯一匹配，歧义匹配时不写入任何内容——编辑不再需要一次读取加一次整文件写入。
- `file_list { recursive }` 使用相对路径，带深度限制、防环遍历和条目上限；`session_messages` 新增 `sinceSeq`/`role` 用于增量读取 transcript。

## 0.2.1

- `dsh_info` 新增 `version`/`uptimeMs`、`catalog` 块（provider、agent 预设、沙箱模式、权限预设、会话数）以及可选开启的模型列表。
- MCP `initialize` 携带给调用模型的工作流说明；prompt 等待改为在 `session/event` 上唤醒，而不是按固定 200 ms 节奏重读日志。
- `session_usage { includeCost: false }` 在大范围扫描时跳过价格账本，标价总计与真实支出并列聚合；`file_read` 新增 `offset`/`nextOffset`/`maxBytes` 以支持低成本分页。

## 0.2.0

- **用量计费**：每个 `session_prompt` 回复都携带精确的单轮与累计 token（安装 `dsh-cost-meter` 时还含金额），**`session_usage`** 可在事后给出回执——harness 没有会话结束事件，因此计数依托回复和一个显式工具。
- 子代理作为独立行折算进来；fork 继承的前缀被单独区分；压缩会被报告但不计入总量；折算结果已与 harness 自身的 `tokenUsage` 投影核对。
