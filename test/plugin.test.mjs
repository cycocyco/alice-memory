import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../index.mjs';
import { Store } from '../lib/store.mjs';

function makeCtx() {
  const hooks = {};
  const tools = {
    register(tool) {
      tools[tool.name] = tool;
    },
  };
  return {
    hooks,
    tools,
    on(event, fn) {
      (hooks[event] ??= []).push(fn);
    },
  };
}

test('plugin apply wires hooks and tools, captures a turn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'alice-plugin-'));
  const prevDir = process.env.ALICE_MEMORY_DATA_DIR;
  const prevHome = process.env.DSH_HOME;
  const prevKey = process.env.ALICE_MEMORY_API_KEY;
  process.env.ALICE_MEMORY_DATA_DIR = dir;
  // 断网：不给 key、不给 .env，向量留 pending，测试不打外部接口
  process.env.DSH_HOME = dir;
  process.env.ALICE_MEMORY_API_KEY = '';
  try {
    const ctx = makeCtx();
    apply(ctx, { log_level: 'error' });

    assert.ok(ctx.hooks['agent/pre-step']?.length, 'pre-step hook registered');
    assert.ok(ctx.hooks['session/event']?.length, 'session hook registered');
    assert.ok(ctx.hooks.dispose?.length, 'dispose hook registered');
    for (const name of ['alice_memory_save', 'alice_memory_recall', 'alice_memory_forget', 'alice_memory_prune']) {
      assert.ok(ctx.tools[name], `${name} registered`);
    }

    // pre-step: 没命中也要原样放行
    const decision = {
      kind: 'enter',
      messages: [{ role: 'user', content: [{ type: 'text', text: '这是一句没有记忆命中过的随机问题' }] }],
    };
    const out = await ctx.hooks['agent/pre-step'][0]({ agent: { session: { id: 's1' } } }, async () => decision);
    assert.equal(out.kind, 'enter');
    assert.equal(out.messages.length, 1);

    // turn/end: 应当落一条
    const events = ctx.hooks['session/event'][0];
    events({ id: 's1' }, {
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: '把这个项目的 README 补上安装说明和隐私声明' }] },
    });
    events({ id: 's1' }, {
      type: 'assistant/message',
      data: { message: { content: [{ type: 'text', text: '好，先写安装再看隐私那节。' }] } },
    });
    events({ id: 's1' }, { type: 'turn/end', data: {} });

    await new Promise((r) => setTimeout(r, 300));

    const store = new Store({ dataDir: dir, dimensions: 1024, model: 'BAAI/bge-m3', scopeId: 'default' });
    try {
      assert.equal(store.countAll(), 1);
      const row = store.exportAll()[0];
      assert.match(row.user_text, /README/);
      assert.match(row.assistant_text, /安装/);
      assert.equal(row.embedding_status, 'pending'); // 没 key，等 backfill
    } finally {
      store.close();
    }

    // 工具：回想 + 忘掉
    const recalled = await ctx.tools.alice_memory_recall.execute({ query: 'README 安装说明' });
    assert.equal(recalled.ok, true);

    const pruned = ctx.tools.alice_memory_prune.execute({ older_than_days: 30 });
    assert.equal(pruned.ok, true);
    assert.equal(pruned.preview, true);
    assert.equal(typeof pruned.token, 'string');

    await ctx.hooks.dispose[0]();
  } finally {
    if (prevDir === undefined) delete process.env.ALICE_MEMORY_DATA_DIR;
    else process.env.ALICE_MEMORY_DATA_DIR = prevDir;
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
    if (prevKey === undefined) delete process.env.ALICE_MEMORY_API_KEY;
    else process.env.ALICE_MEMORY_API_KEY = prevKey;
    await new Promise((r) => setTimeout(r, 100));
    // Windows 上临时目录偶尔报 EPERM（句柄释放比 unlink 慢一拍），两遍清 + 最终降级为警告
    for (let i = 0; i < 3; i += 1) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        break;
      } catch (err) {
        if (i === 2) console.warn(`temp dir left behind: ${dir} (${err.code})`);
        else await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
});
