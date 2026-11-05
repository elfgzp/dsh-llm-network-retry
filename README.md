# dsh-llm-network-retry

断网时不让一轮对话死掉。连接类失败会**一直重试到网络恢复**（Codex CLI 的做法），其它错误只做**有限次短重试**，所以真正的 400 / 鉴权 / 上下文超长仍然会立刻失败，不会把你的 token 烧在死路上。

装好即生效，不需要配置。

## 安装

需要 DeepSeek Harness 0.2.x。

**在 Web 界面里装**：侧边栏 → **插件** → **添加插件** → **安装第三方插件**，粘贴仓库地址：

```
https://github.com/elfgzp/dsh-llm-network-retry
```

确认后在「已安装插件」里打开 **网络重试**。

**让 agent 装**：在开启了插件管理工具的会话里说

> 从 https://github.com/elfgzp/dsh-llm-network-retry 安装这个插件并启用

**命令行**：

```sh
dsh plugin --profile <profile> add "github:elfgzp/dsh-llm-network-retry#main"
```

装完直接对话即可，断网时会看到聊天里的重试行自己倒数。改了 `config` 或更新了插件代码，把插件 toggle 一次（关掉再打开）就会重载。

---

## 为什么还要一个插件

DSH 自带 `@deepseek-ai/dsh-llm-retry`，它已经能做重试。区别在**预算从哪来**：

| | 自带 llm-retry | 本插件 |
|---|---|---|
| 默认预算 | 每个 provider 的 `retryPolicy`，默认 `normal` = 最多 5 次 | 连接类失败：**无上限**；其它：5 次 |
| 默认退避 | 500 ms → 10 s | 连接类 5 s → 60 s；其它 500 ms → 10 s |
| 约等于多久后放弃 | ~10 秒 | 连接类永不放弃；其它 ~10 秒 |
| 断网 10 秒（合盖、切 VPN、弱网握手）| ❌ 轮次结束，得手动「继续」 | ✅ 自动接上 |

Codex CLI 里这条规则叫 `unbounded_connection_retries`（默认开启）：只有 `ConnectionFailed` 这种「网断了」的错误无上限重试，5 s 起翻倍到 60 s；其余照旧有界。本插件实现的正是这条规则。

## 它怎么工作

挂在 agent loop 的 `agent/request-error` 瀑布上，和自带执行器**同一个扩展点**，所以不需要任何前端代码。每次计划重试都会先写入会话日志（`llm/retry` / `llm/retry-started`），于是聊天界面直接渲染它原生的重试行——实时倒计时、第几次、失败原因：

```
↻ 正在重试… 3/∞ · 12 秒后   连接被重置
```

几个关键决定：

- **先落盘再等待。** 重试记录先写入会话，再启动计时器。崩溃或取消都不会留下看不见的挂起重试，重连后历史仍然自洽。
- **取消立刻生效。** 你按停止，等待中的倒计时当场结束，不会「挂到 60 秒再说」。
- **不重复建链。** 本插件 prepend 在自带执行器之前：连接类失败由它一家接管成一条无限链，而不是「自带 5 次 + 本插件再来一条」。已经自己声明 `mode: always` 的 provider 则完全交给它，不叠加。
- **每条重试都是一次真实计费请求。** 无上限模式会一直重试到你取消或成功为止——这是它的目的，但请知悉。

## 判定表

| 失败 code | 行为 |
|---|---|
| `TRANSPORT` / `TIMEOUT` / `NETWORK` | ♾️ 无上限，5 s → 60 s |
| `SERVER` / `RATE_LIMIT` / `EMPTY_RESPONSE` | 有界，默认 5 次，500 ms → 10 s |
| `AUTH` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `INVALID_REQUEST` | 🛑 不重试，立即交给下游 |
| 本轮已取消 | 🛑 不重试，且不惊动下游执行器 |
| 未列出的 code | 交给下游（`preset: always` 时改为重试） |

服务端返回的 `Retry-After` 会被尊重——只要它不超过本策略的上限；超过上限就用本地退避，而不是让策略就此终止。

## 进程崩溃中断的那一轮

「任务已停止 · DSH 进程在本轮完成前退出……未完成的工具调用结果未知」是**另一种**失败，和断网无关：进程被杀/崩溃/关闭超时后，`agent-loop` 在下次启动时发现日志末尾有一轮没闭合，补一条合成的 `turn/end{interrupted}` 把它关掉。那时没有请求在飞，请求级重试插不进去，所以需要单独一条链路。

本插件在输入框下方给一条提示：

```
上次运行被中断（第 3 轮）
DSH 在本轮完成前退出。这些工具调用的结果未知：bash、write。请核对真实状态后再继续。
                                    [ 继续上次任务 ]  [ 不用了 ]
```

### 启动扫描：侧边栏标记

**DSH 启动时扫描全部会话**，找出上次以崩溃中断收尾的那些，在侧边栏对应会话行标题前点一个小黄点，鼠标悬停显示「第 N 轮被中断，这些工具调用结果未知：…」。点开该会话就自动接着跑。

扫描是**只读**的（`open(id, 'read')`，不取写权，不会和你的点击抢会话），有限并发（默认 4），单个会话读失败只跳过它、不影响其它会话，可取消。

### 自动继续

**打开一个有崩溃中断的会话时，插件自动把那一轮接着跑下去**，不需要点「继续」。

触发条件是「日志末尾那一轮是 `interrupted`」，不是启动来源——因为打开既有会话走的是 `agents.resume`，它发出的 source 是 `resume`；`startup` 只用于新建空会话。用日志判断才能同时做到：崩溃会话续跑、三个月前的正常会话不动、崩溃可复现时不循环。

`clear` / `compact` 不自动续。

### 手动继续

其它情况（或自动路径已用过一次）下，输入框下方出现提示条：

```
上次运行被中断（第 3 轮）
DSH 在本轮完成前退出。这些工具调用的结果未知：bash、write。请核对真实状态后再继续。
                                    [ 继续上次任务 ]  [ 不用了 ]
```

两种方式写入的是同一条消息，让模型按顺序做：先核实真实状态（文件、Git、远端、服务）→ 只直接重试只读或幂等操作 → 有副作用的先确认是否已生效 → 状态不清楚先问你。

几条刻意的设计：

| 决定 | 原因 |
|---|---|
| **不盲目重放**：消息第一条就写明这是进程死亡后的续跑、工具结果未知，并要求先核实真实状态 | 进程死亡时可能正有 `git push`、`npm publish`、部署在飞，盲目重跑可能重复执行 |
| **防重启循环**：自动续跑只对「本插件尚未续跑过」的那一轮生效 | 如果崩溃可复现（续跑又崩），下一次重启不再自动续，改为留给人工判断——否则会无限重启 |
| 只看**日志末尾那一轮** | 你已经「继续」过之后产生的正常轮次会让它不再提示，不打扰 |
| 继续前**重新读一次日志** | 陈旧横幅不会凭空注入一轮；双击也只开一轮 |
| 用 `agent.followup()`，不用 `sessionController.prompt()` | 后者把消息源写成 `user-rpc`，会让插件文本看起来和你亲手打的一模一样 |
| 消息 `source` 标记为插件（自动路径另带 `automatic: true`） | 日志里能看出这条不是你写的，也能区分自动/手动 |
| 会话没在运行就明确拒绝 | 提示你先打开该会话，而不是假装成功 |

这条链路需要 `sessionPersistence` 与 `connection` 两个服务，缺任何一个就整体不激活，不会半残。

## 配置（全部可选）

默认值已经就是 Codex 的形状。要改再改，`config` 留空即可：

```yaml
- insert:
    - id: llm-network-retry
      name: dsh-llm-network-retry
      config:
        preset: codex                # codex | always | normal
        maxRetries: 5                # 非连接类失败的预算
        unboundedConnectionRetries: true
        maxUnboundedWaitMs: 0        # 0 = 一直等；1800000 = 最多等 30 分钟
        providers: []                # [] = 所有 provider
        models: []                   # [] = 所有模型
        honorRetryAfter: true
        respectProviderPolicy: true  # provider 自己 always 时让位给它
        requestBackoff:
          initialDelayMs: 500
          maxDelayMs: 10000
          jitterRatio: 0.1
          multiplier: 2
        connectionBackoff:
          initialDelayMs: 5000
          maxDelayMs: 60000
          jitterRatio: 0.1
          multiplier: 2
```

写错字段名会在激活时直接报错，而不是悄悄不生效。

三种 preset：

- `codex`（默认）——连接类无上限，其它有界。日常用这个。
- `always` —— 只要不是致命错误就无上限重试。适合「宁可等一小时也别断」的长任务。
- `normal` —— 任何情况都不无上限，等价于自带 llm-retry 的默认行为，只是预算由本插件管。

## 更新与重启

改完代码或更新插件后，**关掉再打开**该插件（`plugin_manager` 的 `set_plugin` 两次，或设置页里的开关）即可让宿主半边重新加载。

**唯独新增浏览器半边需要重启一次 Harness。** `dsh-client-modules` 会按 Loader specifier 缓存「这个包是不是客户端包」的结论直到进程重启——所以一个*原本没有* `dsh.client` 段的包，即使后来加上了，也要重启才会被发现。只是改 `lib/client.js` 的内容则不需要重启（走 HMR 重建）。

## 测试

```bash
node --test test/*.test.js
```

共 101 个测试：

| 文件 | 内容 |
|---|---|
| `test/policy.test.js` | 重试判定、退避、`Retry-After`、作用域 |
| `test/host.test.js` | 瀑布行为：先落盘再等待、取消、委派、卸载 |
| `test/resume.test.js` | 崩溃判定：只看末尾轮次、未完成工具配对、防重启循环、继续消息措辞 |
| `test/host-recovery.test.js` | 恢复操作：只读打开日志、幂等、拒绝陈旧横幅 |
| `test/scan.test.js` | 启动扫描：只读不取写权、句柄不泄漏、单会话失败不影响整体、可取消 |
| `test/crash-recovery-real.test.js` | **用真实的 Context / Service 启动真实 Cordis**：RPC 行为、打开会话即自动续跑、崩溃可复现时不死循环、扫描端点只读 |
| `test/composition.test.js` | 加载**真实的**自带 `dsh-llm-retry` 执行器，验证不双重建链、事件字段逐字段一致 |

最后两组都需要能读取 `app.asar`（加载真实的自带执行器和真实的 Cordis），所以要用 Harness 自带的 Node 跑；普通 Node 下这 15 个会自动 skip：

```bash
DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" --test test/*.test.js
```

## 已知边界

- 只覆盖**模型请求**失败。真正要命的是这一层——工具调用、shell 命令失败都有自己的超时与重试语义，混在一起会更难排查。
- 直接调用 `ctx.llm.stream()` 的代码不走 agent loop，因此不享受这里的重试（自带执行器也是同样的边界）。
- 重试行只在重试真正发生时出现在聊天里；平时没有常驻 UI 元素。
- 崩溃恢复只处理**日志末尾**那一轮。更早的中断轮次已经被后续轮次覆盖，页面不会追问。

## 参考

Codex CLI (`openai/codex`) 的重试实现：`codex-rs/core/src/responses_retry.rs`（无上限连接重试、5 s→60 s）、`codex-rs/codex-client/src/retry.rs`（有界请求重试、±10% 抖动、`Retry-After`）、`codex-rs/model-provider-info/src/lib.rs`（`request_max_retries = 4`、`stream_max_retries = 5`、`unbounded_connection_retries`）。
