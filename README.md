# alice-memory

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的长期记忆插件。

会话结束后自动把值得记的东西落库，下一轮对话时按语义相关性静默召回。另外给一组显式工具，随时记、随时想、随时忘。

**两个版本，同一份数据。** 本仓库是**默认零模型调用**那条：不额外花钱、不额外发请求，**装完不配任何东西就能跑**，代价是判定靠形式规则——规则能拦形式，拦不住内容，形式过关的闲聊也会被记下来。想要更干净的库、不在乎那点模型调用费，用支线 [**alice-memory-llm**](https://github.com/cycocyco/alice-memory-llm)：捕获不再靠规则闸门，随口闲聊进不来，只把主对话模型提炼出的一句话条目写进库。数据目录、表结构、向量检索和工具都一样，两条线随时换着装，记忆不会丢。

零第三方依赖，纯 Node（`node:sqlite`），不需要 Python、不需要额外数据库服务。

> **测试基线**：开发与验证全部在 **npm 方式安装的 DSH** 上完成（`npm i -g @deepseek-ai/dsh`，浏览器打开 `dsh web` 的 GUI）。**Electron 桌面版没有测过，不保证能用。**

---

## 它能干什么

**自动捕获 + 自动召回。** 每轮结束时判断这段对话值不值得记——「好的」「继续」、斜杠命令、插件自己的注入都会被过滤掉——压缩成脱敏后的问答文本落库。下一轮对话开始前，按语义相关性静默取回最相关的几条塞进上下文，你不需要开口说「回忆一下」。

**手动记、手动想。** 你说「记一下」「记住」，它写一条 pinned 记忆，永久保留、不衰减、不会被清理。你说「回忆一下」「之前那个」，它主动检索给你。

**冷热衰减分层。** 不是所有记忆都值得每轮扫一遍。按「时间衰减 + 被强化次数」把记忆分成 hot / warm / cold，只有热的常驻内存参与每轮检索，冷的留在磁盘上按需唤醒。记忆量从几十条长到上万条，召回延迟基本不变。

**批量整理工具。** 记忆会不知不觉混进没用的条目，也会把同一件事记成好几遍。`alice_memory_tidy` 用一个入口干三件事：翻条目、按 id 批量删、把多条合并成一条新总结。代码先用向量把「可能重复」的成簇、把空壳挑出来，把候选池收紧，语义判断留给你。

**可以接入 cron 自动整理。** 插件本身不做调度——要不要定期整理、隔多久一次、整理完报告投到哪，都是你自己的事。想每半月跑一轮的话，见 [TIDY.md](TIDY.md) 末尾那份可直接喂给 agent 的任务说明。

**记忆是普通数据。** 存在一个 SQLite 文件里，可以看、可以 `export` 成 jsonl、可以精准删、可以整个库搬走。

---

## 适用人群

**适合你，如果：**

- 你天天用 AI 干活，希望它能记住上周定下的方案、这个项目用的规范、你反复交代过的偏好。
- 你的记忆量迟早会上千条，而「把所有历史塞回上下文」早就撞墙了。
- 你接受为 embedding 付费，或者愿意在本机跑一个向量模型（不配也能用，只是退化成关键词检索）。
- 你想让记忆可见、可改、可删，而不是黑箱。

**不适合你，如果：**

- 你只想记几条稳定的小事实（喜欢什么语言、这个项目用什么包管理器）。那种场景用 Markdown 文件 + 每轮注入就够了，简单、透明、零成本，还能用 git 管。
- 你的环境装不了 Node，或者用不了 `node:sqlite`（要求 Node ≥ 24）。

---

## 用之前要想清楚的代价

**一、想要语义召回，就必须自己配一个向量服务。**

**不配也能用**——插件会自动退化成纯全文/关键词检索：记忆照常写、照常召回，只是「上次那个备份」和 `memory-backup-20261008` 这种换个说法的情况对不上号。这是默认状态，零成本、零外部依赖。

要开启真正的语义召回，填 `embedding.url` / `embedding.model`，再把 key 写进 `$DSH_HOME/.env`。两条路：

- **调云端 API。** 便宜但不是免费，而且**记忆正文会发给服务商**。任何 OpenAI 兼容的 `/v1/embeddings` 接口都行，不限于某一家。
- **本机跑模型。** 数据不出机器，但要自己装、自己维护，占内存也占启动时间。

**这两条都不接受的话，就停在纯文本检索模式**——功能完整，只是召回靠字面匹配。

**二、冷层不是免费午餐。**

老记忆不在内存里，召回时要唤醒后台线程扫磁盘，那份延迟算在你这一轮的等待里。

**三、复杂度是真的。**

这套东西比「一个 Markdown 文件」复杂得多。出问题时排查路径更长，所以带了 CLI 和 `doctor` 子命令。如果你不需要跨几千条记忆做语义召回，这些复杂度就是白付的。

**四、两个版本各有各的代价。**

本仓库是规则判定：零成本，但拦不住「形式过关、内容没价值」的闲聊。LLM 版判定更准，但每次提炼要调一次模型，那是真金白银。

---

## 安装

**第一步，装插件。**

```bash
dsh plugin --profile <你的 profile> add dsh-alice-memory
```

国内网络加个镜像会快很多：`--registry https://registry.npmmirror.com`。

**不想走 npm，也可以从 git 装**（要求 GitHub 直连可达）：

```bash
dsh plugin --profile <你的 profile> add github:cycocyco/alice-memory
```

**想先看一遍代码再装，就链本地源码**：

```bash
git clone https://github.com/cycocyco/alice-memory.git
dsh plugin --profile web add file:/absolute/path/to/alice-memory
```

**第二步，重启 DSH。**

插件是后端插件，改完必须重启进程，没有热重载。装完重启，插件会自己建库、自己往内存里灌索引，不需要初始化脚本。

要求 Node ≥ 24（`node:sqlite` 从 24 起稳定）。

**第三步，确认它跑起来了。**

```bash
alice-memory status
```

到这一步就已经能用了——捕获、召回、工具全部工作，召回走全文/关键词通道。

**第四步（可选，但强烈建议）：接一个向量服务，开启语义召回。**

见下面的配置一节。不接也能用，只是换个说法就召不回来了。

## 配置

插件开箱即用，默认配置在 `lib/config.mjs` 里。要改就把 `config.example.json` 复制成插件目录下的 `config.json`（`config.json` 已在 `.gitignore` 里，不会被提交）。

**默认不预设任何向量服务商**——`embedding.url` 和 `model` 都是空的。想开启语义召回，自己填：

```jsonc
{
  "data_dir": "",                    // 留空 = $DSH_HOME/alice-memory
  "scope_id": "default",             // 多套记忆用不同 scope 隔离
  "api_key_env": "EMBEDDING_API_KEY",// 密钥从这个环境变量读
  "embedding": {
    "url": "",                       // 任何 OpenAI 兼容的 /v1/embeddings 接口
    "model": "",                     // 服务商侧的模型名
    "dimensions": 1024               // 必须和模型的输出维度一致
  },
  "recall": { "limit": 3, "timeout_ms": 6000, "max_chars": 400 },
  "capture": { "min_prose": 25, "daily_cap": 150 },
  "memory": { "hot_max": 3000, "warm_max": 12000, "half_life_days": 45 }
}
```

然后把 key 放进 `$DSH_HOME/.env`（默认 `$DSH_HOME` 是 `~/.dsh`）：

```bash
EMBEDDING_API_KEY=你的密钥
```

比重之优先级：环境变量 > `config.local.json` > `config.json` > 内置默认值。

**改完用 `alice-memory doctor` 验一下。** 它会真发一次请求，告诉你连通性和维度对不对：

```
embedding   https://你的服务商/v1/embeddings 你的模型 dims=1024
api key     ok
probe       ok (1024 dims)
```

没配的时候它会直接说 `未配置（url / model / key 缺一）`，不会假装成功。

**换模型等于全库重嵌**，维度变了尤其麻烦，选之前想清楚。之前没配、跑了一段时间纯关键词模式的库，配好之后已有的记忆会在后台自动补齐向量，不用手工干预。

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| `alice_memory_save` | 「记一下」「记住」——手动存一条，默认 pinned，不衰减 |
| `alice_memory_recall` | 「回忆一下」「之前那个」——主动检索 |
| `alice_memory_forget` | 「删掉关于 X 的记忆」——按 id 精确删；按关键词只列命中，带 `confirm` 才真删 |
| `alice_memory_prune` | 「清理冷记忆」——列出长期没被召回的冷记忆，**默认只预览** |
| `alice_memory_tidy` | 「整理记忆库」「合并重复的记忆」——翻条目 / 批量删 / 合并，默认只出 diff |

整理功能的用法见 [TIDY.md](TIDY.md)。

## 命令行

排查问题比翻日志快：

```bash
alice-memory status                        # 条数 / 分层分布 / key 是否可用
alice-memory doctor                        # 真发一次 embedding 探活
alice-memory recall "上周说的那个方案"       # 看召回结果和耗时分解
alice-memory remember "以后都用 pnpm" --title 包管理
alice-memory list --keyword 代理 --limit 20 # 翻条目
alice-memory tidy                          # 整理候选：重复簇 / 空壳 / 久未用
alice-memory merge --ids a,b,c --content "总结" --apply
alice-memory forget --ids a,b,c            # 精确批删
alice-memory export dump.jsonl
alice-memory migrate --from /old/memory-store  # 把散落在别处的旧库并进当前库
```

`--dir` 可以把整套库指到别处试跑，优先级最高（压过环境变量），不会碰你正在用的库。

## 隐私

三条要说清楚：

1. **配了向量服务的话，记忆正文会发给你配的那家。** 不想让某段内容外发，就用本地模型，或者把 `embedding.url` 指到自己的网关。**不配就完全不出网。**
2. **默认带脱敏。** `redact: true` 时，`sk-`、`ghp_`、`github_pat_`、`xoxb-`、`AKIA`、`Bearer`、JWT、长 hex、base64 块、`-----BEGIN ... PRIVATE KEY-----` 会被替换成 `[redacted:xxx]` 再入库。这是兜底，不是保险箱——别指望它挡住所有形态的密钥。
3. **数据全在你自己的机器上。** 库文件在 `data_dir` 里，插件不联网、不上传、不统计。仓库里没有任何数据文件。

`.gitignore` 已经排除了 `*.sqlite3*`、`config.json`、`.env`——如果你把 `data_dir` 指到仓库里面，记得别手滑 `git add -f`。

## 更多

- [ARCHITECTURE.md](ARCHITECTURE.md) —— 数据模型、召回流程、性能实测、为什么不选更简单的做法
- [TIDY.md](TIDY.md) —— 整理记忆库：候选怎么来、删和合并怎么做、怎么接成周期性任务
- [CHANGELOG.md](CHANGELOG.md) —— 每个版本改了什么、升级会自己做什么

## License

MIT
