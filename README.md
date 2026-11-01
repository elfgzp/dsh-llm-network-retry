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

## 安装

```bash
# 已经在用 plugin_manager 安装过；重新安装/更新：
#   plugin_manager → install_bundle → 目标为本目录
```

替换已安装的包需要重启一次 Harness 才能加载新的 JS 模块（HMR 只对新安装的 bundle 生效）。

## 测试

```bash
node --test test/*.test.js
```

共 58 个测试：51 个单元/行为测试，另有 7 个组合测试会加载**真实的**自带 `dsh-llm-retry` 执行器，验证两者不会同时建链、且写入的事件字段与它完全一致（聊天界面按字段名渲染重试行）。组合测试需要能读取 `app.asar`，所以要用 Harness 自带的 Node 跑；普通 Node 下这 7 个会自动 skip：

```bash
DSH_DESKTOP_NODE_EXECUTABLE="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/bin/node" --test test/*.test.js
```

## 已知边界

- 只覆盖**模型请求**失败。真正要命的是这一层——工具调用、shell 命令失败都有自己的超时与重试语义，混在一起会更难排查。
- 直接调用 `ctx.llm.stream()` 的代码不走 agent loop，因此不享受这里的重试（自带执行器也是同样的边界）。
- 重试行只在重试真正发生时出现在聊天里；平时没有常驻 UI 元素。

## 参考

Codex CLI (`openai/codex`) 的重试实现：`codex-rs/core/src/responses_retry.rs`（无上限连接重试、5 s→60 s）、`codex-rs/codex-client/src/retry.rs`（有界请求重试、±10% 抖动、`Retry-After`）、`codex-rs/model-provider-info/src/lib.rs`（`request_max_retries = 4`、`stream_max_retries = 5`、`unbounded_connection_retries`）。
