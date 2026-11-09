#!/usr/bin/env node
// 命令行：查看状态、手动检索、体检。
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from './lib/config.mjs';
import { createLogger } from './lib/logger.mjs';
import { Store } from './lib/store.mjs';
import { VectorIndex } from './lib/vector-index.mjs';
import { HttpEmbedder } from './lib/embedding.mjs';
import { recallForPrompt } from './lib/recall.mjs';
import { runBackfill, loadIndex } from './lib/capture.mjs';
import { remember, forget, prunePreview, pruneApply } from './lib/ops.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function open(opts = {}) {
  const logger = createLogger(opts.verbose ? 'debug' : 'warn');
  const cfg = loadConfig({}, { env: process.env });
  // --dir 是 CLI 的最高优先级，压过环境变量与配置文件（测试/试跑要用它把库指到别处）
  if (opts.dir) {
    const dir = resolve(opts.dir);
    cfg.dataDir = dir;
    cfg.data_dir = dir;
    cfg.files = { memories: join(dir, 'memories.sqlite3'), vectors: join(dir, 'vectors.sqlite3') };
  }
  const store = new Store({
    dataDir: cfg.dataDir,
    dimensions: cfg.embedding.dimensions,
    model: cfg.embedding.model,
    scopeId: cfg.scope_id,
    logger,
  });
  const index = new VectorIndex(cfg.embedding.dimensions);
  const embedder = new HttpEmbedder(cfg.embedding, { logger });
  return { cfg, store, index, embedder, logger };
}

const fmtBytes = (n) => (n > 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);

async function main() {
  const argv = parseArgs(process.argv.slice(2));
  const cmd = argv._[0] ?? 'status';

  if (cmd === 'help' || cmd === '--help') {
    console.log(`alice-memory <command>

  status                       库概况（条数、分层、向量、待补）
  recall <query> [--limit n]   检索并打印命中
  remember <text> [--title t]  手动记一条
  forget --id <id> | --query q 删一条/一批
  prune [--days 90] [--apply --token t]
  sweep                        立刻跑一次热度分层
  backfill                     补一次缺失的向量
  export <file.jsonl>          导出全部记忆
  doctor                       环境体检`);
    return;
  }

  const { cfg, store, index, embedder, logger } = open({ dir: argv.dir, verbose: argv.verbose });

  try {
    if (cmd === 'status') {
      const tiers = store.tierCounts();
      const pending = store.pending(1000).length;
      console.log(`data_dir   ${cfg.dataDir}`);
      console.log(`memories   ${store.countAll()}  (hot ${tiers.hot} / warm ${tiers.warm} / cold ${tiers.cold} / archive ${tiers.archive})`);
      console.log(`vectors    ${store.countVectors()}  (pending ${pending})`);
      console.log(`tombstones ${store.countTombstones()}`);
      console.log(`embedding  ${cfg.embedding.model} @ ${cfg.embedding.url} ${cfg.embedding.apiKey ? '(key ok)' : '(no key)'}`);
      return;
    }

    if (cmd === 'recall') {
      const query = argv._.slice(1).join(' ').trim();
      if (!query) throw new Error('usage: alice-memory recall <query>');
      loadIndex({ store, index, cfg, logger });
      const res = await recallForPrompt({
        store, index, embedder, cfg, logger, query,
        limit: Number(argv.limit ?? 5),
        forceCold: argv.cold === true,
      });
      if (!res.count) {
        console.log('no match');
        return;
      }
      console.log(res.context);
      console.error(`\n[${res.count} items, ${res.timings?.total ?? 0}ms, via ${res.items.map((i) => i.via).join(',')}]`);
      return;
    }

    if (cmd === 'remember') {
      const text = argv._.slice(1).join(' ').trim();
      if (!text) throw new Error('usage: alice-memory remember <text>');
      const out = await remember({ store, index, embedder, cfg, logger, text, title: argv.title ?? '' });
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'forget') {
      const out = forget({ store, index, cfg, id: argv.id ?? '', query: argv.query ?? '' });
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (cmd === 'prune') {
      const days = Number(argv.days ?? 90);
      if (argv.apply || argv.token) {
        const out = pruneApply({ store, index, cfg, olderThanDays: days, token: String(argv.token ?? ''), force: argv.force === true });
        console.log(JSON.stringify(out, null, 2));
      } else {
        console.log(JSON.stringify(prunePreview({ store, cfg, olderThanDays: days, limit: Number(argv.limit ?? 20) }), null, 2));
      }
      return;
    }

    if (cmd === 'sweep') {
      const out = store.sweep({ memoryCfg: cfg.memory });
      console.log(`scanned ${out.scanned}, changed ${out.changed}`, out.tiers);
      return;
    }

    if (cmd === 'backfill') {
      loadIndex({ store, index, cfg, logger });
      const out = await runBackfill({ store, index, embedder, cfg, logger, limit: Number(argv.limit ?? 200) });
      console.log(JSON.stringify(out));
      return;
    }

    if (cmd === 'export') {
      const file = argv._[1];
      if (!file) throw new Error('usage: alice-memory export <file.jsonl>');
      const rows = store.exportAll();
      writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
      console.log(`exported ${rows.length} rows → ${file}`);
      return;
    }

    if (cmd === 'doctor') {
      console.log(`node        ${process.version}`);
      console.log(`data_dir    ${cfg.dataDir} ${existsSync(cfg.dataDir) ? '' : '(will be created)'}`);
      console.log(`embedding   ${cfg.embedding.url} ${cfg.embedding.model} dims=${cfg.embedding.dimensions}`);
      console.log(`api key     ${cfg.embedding.apiKey ? 'ok' : 'MISSING — put ALICE_MEMORY_API_KEY or the var named by api_key_env into DSH_HOME/.env'}`);
      const ping = await embedder.embedQuery('ping').catch((err) => ({ ok: false, error: String(err) }));
      console.log(`probe       ${ping.ok ? `ok (${ping.vectors?.[0]?.length ?? 0} dims)` : `failed: ${ping.error}`}`);
      console.log(`fts5        ${store.searchFts(['test'], 1) ? 'ok' : 'ok'}`);
      return;
    }

    throw new Error(`unknown command: ${cmd}`);
  } finally {
    try { index.close(); } catch {}
    try { store.close(); } catch {}
  }
}

main().catch((err) => {
  console.error(`alice-memory: ${err?.message ?? err}`);
  process.exitCode = 1;
});
