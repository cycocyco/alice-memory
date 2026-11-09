// 透明捕获：筛掉噪声 → 脱敏 → 去重落库 → 异步补向量。
import { collapse, clip, localDate } from './text.mjs';
import { redact } from './redact.mjs';

const FILLER = /^(嗯+|哦+|噢+|啊+|呃+|好的?|行|可以|收到|明白|了解|谢谢|多谢|辛苦了|继续|在吗|hi|hello|hey|ok|okay|thx|thanks|test|测试|试试)[\s!！。.~～?？]*$/i;
const OURS = /\[alice-memory[:\]]|- \[20\d\d-\d\d-\d\d\]/;

/** 判断这一轮值不值得记 */
export function isWorthKeeping({ userText, assistantText, cfg }) {
  const u = collapse(userText ?? '');
  const a = collapse(assistantText ?? '');
  if (!u) return { keep: false, reason: 'empty user text' };
  if (u.length < 3) return { keep: false, reason: 'too short' };
  if (/^[/／]\S*$/.test(u)) return { keep: false, reason: 'slash command' };
  if (FILLER.test(u)) return { keep: false, reason: 'filler' };
  if (OURS.test(u)) return { keep: false, reason: 'our own recall block' };
  if (!/[\p{L}\p{N}]/u.test(u)) return { keep: false, reason: 'no words' };

  const minProse = Number(cfg?.capture?.min_prose ?? 25);
  const signal = u.length + Math.min(a.length, 200);
  if (u.length < minProse && !a) return { keep: false, reason: 'too little substance' };
  if (signal < minProse && u.length < 12) return { keep: false, reason: 'too little substance' };
  return { keep: true, reason: '' };
}

export function composeContent({ userText, assistantText, cfg }) {
  const labels = cfg.recall?.labels ?? {};
  const user = redact(collapse(userText));
  const assistant = redact(collapse(assistantText ?? ''));
  const u = clip(user.text, Number(cfg.capture?.max_user_chars ?? 2000));
  const a = clip(assistant.text, Number(cfg.capture?.max_assistant_chars ?? 4000));
  const head = `${labels.user ?? 'User'}: ${u}`;
  const redactions = [...user.hits, ...assistant.hits];
  return { content: a ? `${head}\n${labels.assistant ?? 'Assistant'}: ${a}` : head, redactions };
}

/**
 * 一轮结束后调用。返回 {stored, id?, reason?}，不抛异常。
 */
export async function captureTurn({
  store, index, embedder, cfg, logger,
  sessionId, userText, assistantText, now = Date.now(),
}) {
  if (cfg.capture?.enabled === false) return { stored: false, reason: 'capture disabled' };

  const verdict = isWorthKeeping({ userText, assistantText, cfg });
  if (!verdict.keep) return { stored: false, reason: verdict.reason };

  const day = localDate(new Date(now));
  const cap = Number(cfg.capture?.daily_cap ?? 150);
  if (store.dayCount(day) >= cap) return { stored: false, reason: `daily cap ${cap} reached` };

  const { content, redactions } = composeContent({ userText, assistantText, cfg });
  const { id, inserted } = store.insertMemory({
    occurredAt: new Date(now).toISOString(),
    localDate: day,
    kind: 'turn',
    userText,
    assistantText,
    content,
    sessionId,
    scopeId: cfg.scope_id,
    source: 'auto',
    memoryCfg: cfg.memory ?? {},
    embeddingStatus: 'pending',
  });

  if (!inserted) return { stored: false, id, reason: 'duplicate' };
  if (redactions.length) {
    logger?.info?.(`captured ${id}, redacted ${redactions.map((h) => `${h.rule}×${h.count}`).join(',')}`);
  } else {
    logger?.debug?.(`captured ${id} (${content.length} chars)`);
  }
  return { stored: true, id };
}

/** 把一批行补成向量，成功则入热区索引 */
export async function embedRows({ store, index, embedder, cfg, logger, rows }) {
  if (!rows.length) return { ok: 0, failed: 0 };
  if (!embedder?.ready) return { ok: 0, failed: rows.length, skipped: 'embedder not ready' };

  let ok = 0;
  let failed = 0;
  const batch = Math.max(1, Number(cfg.embedding?.batch ?? 16));

  for (let i = 0; i < rows.length; i += batch) {
    const chunk = rows.slice(i, i + batch);
    const res = await embedder.embedDocs(chunk.map((r) => r.content));
    if (!res.ok) {
      for (const row of chunk) store.markEmbeddingFailed(row.id, res.error);
      failed += chunk.length;
      logger?.warn?.(`embedding batch failed: ${res.error}`);
      continue;
    }
    chunk.forEach((row, k) => {
      const vec = res.vectors[k];
      if (!vec || !store.setVector(row.id, vec, cfg.embedding.model)) {
        store.markEmbeddingFailed(row.id, 'empty vector');
        failed += 1;
        return;
      }
      if (row.tier !== 'cold' && row.tier !== 'archive') index.set(row.id, vec);
      ok += 1;
    });
  }
  return { ok, failed };
}

/** 待补向量的行：pending，或失败且过了重试窗口 */
export function pendingRows({ store, cfg, limit = 64, now = Date.now() }) {
  const retryMs = Number(cfg.capture?.embed_retry_minutes ?? 5) * 60_000;
  return store.pending(limit).filter((row) => {
    if (row.embedding_status !== 'failed') return true;
    const at = Date.parse(row.created_at ?? '');
    return !Number.isFinite(at) || now - at > retryMs;
  });
}

/** 一轮 backfill，供定时器与 CLI 复用 */
export async function runBackfill({ store, index, embedder, cfg, logger, limit = 64 }) {
  const rows = pendingRows({ store, cfg, limit });
  if (!rows.length) return { ok: 0, failed: 0, tried: 0 };
  const out = await embedRows({ store, index, embedder, cfg, logger, rows });
  return { ...out, tried: rows.length };
}

/** 启动时把 hot/warm 的向量灌进连续缓冲 */
export function loadIndex({ store, index, cfg, logger }) {
  const rows = store.hotWarmRows(Number(cfg.memory?.hot_max ?? 3000) + Number(cfg.memory?.warm_max ?? 12000));
  if (!rows.length) return { loaded: 0 };
  const vecs = store.vectorsFor(rows.map((r) => r.id));
  let loaded = 0;
  for (const row of rows) {
    const vec = vecs.get(row.id);
    if (!vec) continue;
    index.set(row.id, vec);
    loaded += 1;
  }
  logger?.info?.(`hot index loaded: ${loaded}/${rows.length} vectors`);
  return { loaded, rows: rows.length };
}
