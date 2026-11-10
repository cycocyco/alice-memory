# alice-memory

> **两个版本，同一份数据。** 想要自动化更彻底、记忆库更干净，而且不在乎那点模型调用费——用支线 [**alice-memory-llm**](https://github.com/cycocyco/alice-memory-llm)：捕获不再靠规则闸门，随口闲聊进不来，只把主对话模型提炼出的一句话条目写进库。数据目录、表结构、向量检索和四个工具都一样，两条线随时换着装，记忆不会丢。
>
> 本仓库是**零模型调用**的那条：不额外花钱、不额外发请求、没有 key 也能跑，代价是判定靠形式规则——规则能拦形式，拦不住内容，形式过关的闲聊也会被记下来。预算敏感、或者只想跑本地不接模型，选这条。

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的长期记忆插件。会话结束后自动把值得记的东西落库，下一轮对话时按语义相关性静默召回，另外给你三个（其实是四个）显式工具，随时记、随时想、随时忘。

零第三方依赖，纯 Node（`node:sqlite`），不需要 Python、不需要额外数据库服务。

> **测试基线**：开发与验证全部在 **npm 方式安装的 DSH** 上完成（`npm i -g @deepseek-ai/dsh`，浏览器打开 `dsh web` 的 GUI）。**Electron 桌面版没有测过，不保证能用。**

## 它解决什么

大多数「AI 记忆」是两种极端：要么把所有历史一股脑塞回上下文，要么只留一个摘要文件。前者会撞上上下文上限，后者会丢掉细节。

这个插件的做法是：

- **自动捕获**：每轮结束时判断这段对话值不值得记（过滤「好的」「继续」、斜杠命令、插件自己的注入），压缩成长度受限的问答文本，脱敏后落 SQLite。
- **混合召回**：向量相似度 + FTS5 全文检索，用 RRF 融合两路排名。语义命中和关键词命中互为兜底。
- **记忆分层**：不是所有记忆都值得每轮扫一遍。按热度（时间衰减 + 被强化次数）把记忆分成 hot / warm / cold，只有 hot + warm 常驻内存。
- **可控**：记忆是数据库里的普通行，可以看、可以导出、可以精准删。

## 安装

还没发到 npm，直接从 git 装：

```bash
dsh plugin --profile <你的 profile> add github:cycocyco/alice-memory
```

想先看一遍代码再装，就链本地源码：

```bash
git clone https://github.com/cycocyco/alice-memory.git
dsh plugin --profile web add file:/absolute/path/to/alice-memory
```

要求 Node ≥ 24（`node:sqlite` 从 24 起稳定）。装完重启 DSH，插件会自己建库、自己往内存里灌索引，不需要初始化脚本。

## 配置

插件开箱即用，默认配置在 `lib/config.mjs` 里。要改就把 `config.example.json` 复制成插件目录下的 `config.json`（`config.json` 已在 `.gitignore` 里，不会被提交）。

```jsonc
{
  "data_dir": "",              // 留空 = $DSH_HOME/alice-memory
  "scope_id": "default",       // 多套记忆用不同 scope 隔离
  "api_key_env": "SILICONFLOW_API_KEY",
  "embedding": {
    "url": "https://api.siliconflow.cn/v1/embeddings",
    "model": "BAAI/bge-m3",
    "dimensions": 1024
  },
  "recall": { "limit": 3, "timeout_ms": 6000, "max_chars": 400 },
  "capture": { "min_prose": 25, "daily_cap": 150 },
  "memory": { "hot_max": 3000, "warm_max": 12000, "half_life_days": 45 }
}
```

优先级：环境变量 > `config.local.json` > `config.json` > 内置默认值。

API key 建议别写进配置文件，放到 `$DSH_HOME/.env`：

```bash
SILICONFLOW_API_KEY=sk-...
```

也可以换任何 OpenAI 兼容的 embedding 接口，改 `embedding.url` / `model` / `dimensions` 就行。**换模型等于全库重嵌**，维度变了尤其麻烦，选之前想清楚。

## 隐私

三条要说清楚：

1. **记忆正文会发给你配置的 embedding 服务商。** 向量检索必须先算 embedding，这是这套方案的物理前提。不想让某段内容外发，就用本地模型，或者把 `embedding.url` 指到自己的网关。
2. **默认带脱敏。** `redact: true` 时，`sk-`、`ghp_`、`github_pat_`、`xoxb-`、`AKIA`、`Bearer`、JWT、长 hex、base64 块、`-----BEGIN ... PRIVATE KEY-----` 会被替换成 `[redacted:xxx]` 再入库。这是兜底，不是保险箱——别指望它挡住所有形态的密钥。
3. **数据全在你自己的机器上。** 库文件在 `data_dir` 里，只有一个 `memories.sqlite3`（正文、向量、墓碑、全文索引同库），插件不联网、不上传、不统计。README 和仓库里没有任何数据文件。

`.gitignore` 已经排除了 `*.sqlite3*`、`config.json`、`.env`——如果你把 `data_dir` 指到仓库里面，记得别手滑 `git add -f`。

## 数据模型

**一个数据目录只有一个库文件**：`<data_dir>/memories.sqlite3`，WAL 模式。正文、向量、墓碑、FTS 全在同一个 SQLite 里。

不拆两个文件是有意的：拆开之后每写一条记忆就要同时动两个库、两次提交、两套备份；跨库 join（比如清孤儿向量）还得 ATTACH。同库之后写入只有一次事务，孤儿向量一条 SQL 就能扫干净。

老版本（v2 及以前）是 `memories.sqlite3` + `vectors.sqlite3` 两份。升级后第一次启动会自动把向量并进单文件，并把老文件挪进 `<data_dir>/legacy/` 留档——占着文件没挪动成功也没事，下次启动会再来一次，导入是幂等的。

`memories` — 记忆正文

| 列 | 说明 |
| --- | --- |
| `id` | 主键 |
| `occurred_at` / `local_date` | 发生时间 / 本地日期（日配额按本地日算） |
| `kind` | `turn`（自动捕获）/ `note`（手动记） |
| `user_text` / `assistant_text` | 拆开存的问答，不再拼成一个 `role=user` 的字符串 |
| `content` | 给 embedding 和全文索引用的一整段文本 |
| `content_sha256` | 唯一索引，同内容不重复入库 |
| `heat0` / `reinforced_at` / `half_life_days` | 热度三元组：上次强化时的热度 / 时间 / 半衰期 |
| `tier` | `hot` / `warm` / `cold` / `archive` |
| `embedding_status` | `pending` / `ok` / `failed`，失败会自动 backfill |
| `pinned` / `importance` | 手动记忆默认 pinned，永不衰减、永不被清理 |

`memories_fts` 是 FTS5 trigram 外部内容表，配 `ai/ad/au` 三个触发器跟主表同步。

`vectors` — 向量

| 列 | 说明 |
| --- | --- |
| `memory_id` | 关联记忆 |
| `vector` | Float32 blob，**写入时就归一化**，检索时只做点积，不再算范数 |
| `model` / `dimensions` | 防串味 |

`tombstones` 记录删除，保证删掉的记忆不会被 backfill 复活。

`meta` 存 schema 版本、维度、模型、scope——换模型或维度时靠它判断要不要重嵌。

## 召回流程

```
用户这轮的话
   └─ embed（带 6s 超时）
        ├─ hot + warm 内存扫描（一块连续 Float32Array，worker 线程里跑）
        ├─ FTS5 全文（永远跑，很便宜）
        └─ 命中不足 → worker 扫全库冷层（900ms 预算，200k 条上限）
   └─ RRF 融合（k=60，向量 1.0 / 全文 0.35 / 冷层 ×0.8）
   └─ top-K 回表 → 注入上下文
```

几个刻意的设计决定：

- **热度不进 SQL。** 存的是 `heat0 / reinforced_at / half_life_days`，衰减在 JS 里现算——`node:sqlite` 未必编译了 `pow()`，而且写死在列里会陷入「排序读到过期值」的怪圈。
- **分层是硬约束。** `hot_max` 3000、`warm_max` 12000，超了就按热度排名往下压，绝不会因为新记忆进来把老记忆往上提。不设上限的分层等于没分层。
- **双阈值滞回。** hot 进 0.6 / 出 0.4，warm 进 0.3 / 出 0.15。单阈值会让边界上的记忆每轮翻来覆去。
- **只有真的被注入上下文才强化。** 候选集里没被用上的不加热度，否则热门越来越热，冷门永远没有出头之日。
- **热区是一块连续内存。** 每轮 `SELECT blob` 出来再逐行解码，1 万条就是 60ms+ 的同步阻塞，分层就白做了。
- **sweep 只写变化的行。** SQLite 单写者，1.5 万行全量 UPDATE 会锁库几百毫秒。

## 工具

| 工具 | 什么时候用 |
| --- | --- |
| `alice_memory_save` | 用户说「记一下」「记住」——手动存一条，默认 pinned，不衰减 |
| `alice_memory_recall` | 用户说「回忆一下」「之前那个」——主动检索 |
| `alice_memory_forget` | 用户说「删掉关于 X 的记忆」——按 id 或子串删，同时删向量、写墓碑 |
| `alice_memory_prune` | 用户说「清理记忆」「整理记忆」——列出长期没被召回的冷记忆，**默认只预览**，带 token 或 `force` 才真删 |

`prune` 只碰 `tier='cold'` 且未 pinned、`importance < 1.5` 的条目。预览会给出条数、占用字节、最近 20 条样例和一个 `confirm_token`，token 是按 cutoff 量化到整点算的——所以预览和真删之间差几秒也不会对不上。

## CLI

插件自带一个命令行，排查问题比翻日志快：

```bash
alice-memory status                        # 条数 / 分层分布 / key 是否可用
alice-memory doctor                        # 真发一次 embedding 探活
alice-memory recall "上周说的那个方案"       # 看召回结果和耗时分解
alice-memory remember "以后都用 pnpm" --title 包管理
alice-memory forget --id <id>              # 或 --query <子串>
alice-memory prune --days 90               # 只预览
alice-memory prune --days 90 --token <t>   # 真删
alice-memory sweep                         # 立刻跑一次热度分层
alice-memory backfill                      # 补 pending 向量
alice-memory export dump.jsonl
alice-memory migrate --from "D:\old-memory"   # 把散落在别处的旧库并进当前库
alice-memory migrate --scan W:\TEMP --dry-run # 先看看能扫到哪些库，不写
alice-memory migrate --scan W:\TEMP --purge   # 导完把只装了库文件的目录一起清掉
```

`migrate` 按 `content_sha256` 去重，同 id 冲突改 id，向量按 `memory_id` 只补不覆盖，所以重复跑是安全的。`--purge` 只删「里面除了库文件没别的东西」的目录，混着别的东西一律拒绝。

`--dir` 可以把整套库指到别处试跑，优先级最高（压过环境变量），不会碰你正在用的库。

库开着的时候目录里还会看到 `memories.sqlite3-wal` / `-shm` 两个伴随文件，这是 WAL 模式的正常产物，进程退出后自动收掉，不是第二份数据。

## 性能

实测环境：Windows 11、Node 26、1 万条 × 1024 维的库。

| 环节 | 耗时 |
| --- | --- |
| embedding 网络往返 | 200–380ms（占大头，取决于服务商） |
| 热区 1 万条向量扫描（worker 线程） | 20–30ms |
| FTS5 全文检索 | ~3ms |
| 冷层全库扫描 | 受 900ms 预算约束 |

端到端召回一条，实测 **289ms**（5 条命中，全部来自向量通道）。

分层是拿内存换延迟：hot + warm 常驻的是一块 `Float32Array`，1.5 万条约 60MB。冷层不占内存，只在需要时由 worker 扫磁盘。

## 为什么不选更简单的做法

记忆插件目前大概有四种形态，这套选了最重的那种，所以得把另外三条路的账摊开算。

|  | 全量注入 Markdown | 纯关键词检索 | 本插件 |
| --- | --- | --- | --- |
| 零外部依赖 | 是 | 是 | 否，要一个 embedding 服务（可换成本地模型） |
| 每轮占固定 token | 条目一多就明显 | 不占 | 不占 |
| 能存整段过程 | 勉强 | 能 | 能 |
| 换个说法也能召回 | 否 | 否 | 是 |
| 专有名词 / 路径 / 代码 | 靠模型自己读 | 准 | 准（走 FTS 通道） |
| 人手读、手改 | 最方便 | 要开库 | `export` 成 jsonl |
| 几千条以后 | 开始靠模型翻文件 | `LIKE` 要全表扫 | 分层，热点常驻内存 |

### 一、记忆就是一堆 Markdown / JSON 文件

做法：一条记忆一个 `.md`，按用户、反馈、项目、参考分类型；启动或每步把文件索引拼进系统提示词，按字节预算截断。

好在哪：人眼能读、能手改，git 能提交能回滚，文件坏了拿编辑器就能救；不依赖任何服务、不发任何请求、不产生费用；换个工具也能把记忆带走。存「这人喜欢什么、这个项目用什么规范」这类稳定的小事实，它是最省心的形态，失败模式也最温和——最坏是记不住，不是记错。

卡在哪：

- 每轮都要占提示词预算，所以条目必须压到一两句。能存下来的是结论，不是「那天到底聊了什么」。
- 索引一长就只能放标题和几个关键词，深一点的内容要么整段塞进去、要么完全不进。几十条很舒服，几千条就得靠模型自己按索引去翻文件——翻得准不准，取决于那一轮它分了多少注意力给这件事。
- 没有相关性排序这回事。要么全给，要么不给。
- 写入靠模型自觉调用工具：该记的漏掉、同一件事记两遍、新内容把旧内容覆盖掉，都是这类做法常见的故障。

我们的取舍：正文放在 SQLite，但留了 `export` 出 jsonl 的口子，能读能改能删；`pinned` 的手动记忆也是按「稳定小事实」的用法设计的。真正的分歧在用法——我们把它当「会话流水 + 可检索的旧事」在用，量级从第一天就奔着上万条，全量注入撑不到那儿。

### 二、纯关键词 / 暴力检索，不做向量

做法：FTS5、BM25，或者干脆 `LIKE '%短语%'` 全表扫，查询时把关键词拆开算命中。

好在哪：零 API、零费用、正文不出本机；几千条以内快得没感觉（FTS5 是个位数毫秒）；结果可解释——为什么召回它，一眼看得出；专有名词、文件路径、命令、代码片段这类「字面精确」的东西，它比向量准得多。

卡在哪：它只认字面。你这次说「上次那个备份」，库里存的是 `memory-backup-20261108`，两边没有一个字重合，召不回来。中文又没有天然词边界，trigram 切出来的片段要么太碎要么太粗。同义、指代、换个说法、中英混说，全都归零。`LIKE` 那条路还得把每行正文读出来才能比对，是实打实的全表扫。

我们的取舍：这条路没丢，只是不当唯一的路。FTS5 trigram 每次召回都跑（3ms 上下），权重 0.35，专有名词和代码片段靠它；向量管「意思像」。两路用 RRF 融合，任何一路单独失效，另一路都还能捞回来。这也是为什么 `min_score` 只卡向量那一路——关键词命中不需要分数门槛，字面重合本身就是证据。

### 三、独立的向量数据库 / 常驻服务

几万条以内，一个 SQLite 文件加一块连续内存就够用。多起一个进程、多一个端口、多一份运维，换不来延迟上的收益。真到十万条以上，瓶颈会变成 ANN 索引本身，那时候换引擎是值得的——现在还不值得。

### 四、这套选择的代价

诚实说三条：

1. **必须有 embedding 服务**，或者自己跑本地模型。这既是费用，也是隐私前提，见上一节。
2. **冷层不免费。** 老记忆不在内存里，召回要唤醒 worker 扫盘，那份延迟是算在这一轮等待里的（900ms 预算）。
3. **复杂度是真的。** 两千多行对一个 `.md` 文件，出问题时排查路径更长——所以带了 CLI 和 `doctor`。

## 开发

```bash
node --test test/     # 19 个用例，约 0.8s，不联网
```

测试用 `FakeEmbedder`（确定性 hash 向量）代替真模型，所以离线能跑。`test/plugin.test.mjs` 用假 ctx 把插件 `apply()` 跑一遍，验证 hook 注册、注入放行、落库、四个工具都在。

`test/upgrade.test.mjs` 专门守升级路径：手工造出 v2 的双库布局（正文库 + 独立 `vectors.sqlite3`），验证打开即并库、老文件进 `legacy/`、反复启动不产生第二份、维度或模型变了的老向量会被打回 `pending` 等重嵌、老文件是坏文件时也不影响启动。

插件结构：

```
index.mjs          插件入口：hook 挂载、四个工具、定时器
cli.mjs            命令行
lib/config.mjs     配置合并 + 路径与 key 解析
lib/store.mjs      SQLite：建表、写入、检索、分层、清理
lib/migrate.mjs    单文件库收束：旧双库并库、散落库导入、目录扫描/清理
lib/vector-index.mjs  热区连续缓冲 + worker 调度
lib/vector-worker.mjs worker：热区扫描 + 冷层全库扫
lib/embedding.mjs  HTTP embedding（可换 Fake）
lib/search.mjs     RRF 融合
lib/capture.mjs    捕获判定、脱敏、日配额、backfill
lib/recall.mjs     召回 + 超时降级
lib/heat.mjs       热度与分层
```

## 更新日志

每个版本改了什么、升级会自己做什么，都记在 [CHANGELOG.md](./CHANGELOG.md)。装过旧版本的话直接看最新的那条，升级不需要手工跑迁移。

## License

MIT
