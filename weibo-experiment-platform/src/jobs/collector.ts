/**
 * 正式实验 - 分批增量建池 + 选帖建实验
 * ============================================================================
 * 策略（16/18/20 每 2 小时一批）：
 *   runCollectBatch()   单批采集 CANDIDATE_BATCH 条候选 → 筛选 → 按作者去重
 *                       upsert 到 candidate_pool（跨批累计）；合格 ≥ TARGET_QUALIFIED
 *                       则标记 pool_full，后续批次跳过采集。红线约束绝不放宽。
 *   finalizeExperiment() 从 candidate_pool 选 EXPERIMENT_POSTS 实验帖（三等分+模板）
 *                       + 其余作备选(is_spare)，写 posts / intervention_logs，
 *                       实验 status → ready。池不足 90 则缩减为最大 3 倍数并告警。
 *
 * 直跑调试：
 *   npx tsx src/jobs/collector.ts batch      # 跑一批采集
 *   npx tsx src/jobs/collector.ts finalize   # 选帖建实验
 */

import { insert, query, maybeOne, updateOne, upsert, count, ensureUniqueIndex } from '../lib/db';
import { randomizeAndGroup, assignTemplates } from '../lib/experiment-engine';
import {
  ScreeningPost,
  CANDIDATE_BATCH,
  MAX_BATCHES,
  TARGET_QUALIFIED,
  EXPERIMENT_POSTS,
  MAX_PAGES_PER_KEYWORD,
  SEARCH_KEYWORDS,
  sleep,
  ts,
  now,
  scrapeRealtimeMids,
  fetchStatusRaw,
  screenStatus,
  getActiveAccounts,
  markAccountExpired,
  isCookieExpired,
} from './shared';
import { collectorLog } from '../lib/logger';
import { isQcPaused } from './qc';

const POOL = 'candidate_pool'; // 跨批累计的合格帖候选池集合
const REGISTRY = 'experiment_author_registry'; // 作者注册表：随机化前原子登记，防重复作者再次入组

/**
 * 原子登记作者（规范 P0-1）：依赖数据库唯一约束 (platform, post_author_id)，
 * 而非"先查再写"（并发下无法防止竞态）。
 * 唯一约束冲突（code 11000）→ 该作者已进入过实验，返回 false，帖子在随机化前跳过。
 */
async function tryRegisterAuthor(platform: string, p: ScreeningPost): Promise<boolean> {
  try {
    await insert(REGISTRY, {
      platform,
      post_author_id: p.authorUid,
      first_post_id: p.postId,
      first_treatment_group: null,
      first_randomization_timestamp: now(),
    });
    return true;
  } catch (e: any) {
    if (e?.code === 11000 || /duplicate key/i.test(String(e?.message || ''))) return false;
    throw e;
  }
}

/**
 * 加载 posts 表中历史实验已出现过的帖子与作者。
 * 全局去重：整个实验历史中出现过的帖子/作者都不允许再次入选，
 * 保证跨实验（跨天）帖子和作者均不重复。
 */
async function loadHistoryExclusions(): Promise<{ midSeen: Set<string>; authorSeen: Set<string> }> {
  const { rows } = await query<{ mid?: string; author_uid?: string }>(
    'posts',
    {},
    { projection: { mid: 1, author_uid: 1 } },
  );
  const midSeen = new Set<string>();
  const authorSeen = new Set<string>();
  for (const r of rows) {
    if (r.mid) midSeen.add(String(r.mid));
    if (r.author_uid) authorSeen.add(String(r.author_uid));
  }
  return { midSeen, authorSeen };
}

/** 找/建当天处于采集期的实验；若当天已 finalize（非 collecting）返回 null 表示无需采集 */
export async function getOrCreateCollectingExp(): Promise<{ id: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] } | null> {
  const today = new Date().toISOString().split('T')[0];
  const existing = await maybeOne<{ id: string; status: string; pool_full?: boolean; batch_count?: number; seen_mids?: string[] }>(
    'experiment_runs',
    { experiment_date: today },
  );
  if (existing) {
    if (existing.status !== 'collecting') {
      console.log(`  当天实验已处于 ${existing.status} 状态，跳过采集`);
      return null;
    }
    return existing;
  }
  const created = await insert<{ id: string }>('experiment_runs', {
    user_id: 'admin',
    date: today,
    experiment_date: today,
    status: 'collecting',
    batch_count: 0,
    pool_full: false,
    seen_mids: [],
    completed_points: [],
    created_at: now(),
  });
  return created ? { id: String(created.id), batch_count: 0, seen_mids: [] } : null;
}

/** 单批采集：抓候选 → 筛选 → 按作者去重 upsert 到候选池 */
export async function runCollectBatch(): Promise<{ experimentId: string; qualified: number; poolFull: boolean } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[采集批次] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return null;
  }
  console.log(`可用账号 (${accounts.length}): ${accounts.map((a) => a.nickname).join(', ')}`);

  const exp = await getOrCreateCollectingExp();
  if (!exp) return null;
  const experimentId = exp.id;

  // 已达标或批次用尽 → 跳过采集
  let qualified = await count(POOL, { experiment_id: experimentId });
  if (exp.pool_full || qualified >= TARGET_QUALIFIED) {
    console.log(`  候选池已达标（${qualified}/${TARGET_QUALIFIED}），跳过本批采集`);
    await updateOne('experiment_runs', { id: experimentId }, { pool_full: true });
    return { experimentId, qualified, poolFull: true };
  }
  if ((exp.batch_count || 0) >= MAX_BATCHES) {
    console.log(`  已达最大批次 ${MAX_BATCHES}，跳过采集`);
    return { experimentId, qualified, poolFull: false };
  }
  console.log(`  当前池: ${qualified}/${TARGET_QUALIFIED}  批次: ${(exp.batch_count || 0) + 1}/${MAX_BATCHES}`);

  // ── 全局去重：历史实验中出现过的帖子/作者不再入选 ──
  const { midSeen: histMids, authorSeen: histAuthors } = await loadHistoryExclusions();
  console.log(`  历史去重范围: ${histMids.size} 帖 / ${histAuthors.size} 作者`);

  // ── 抓取本批候选 mid（排除历史已见 + 历史实验已用）──
  const seen = new Set<string>(exp.seen_mids || []);
  const batchMids = new Set<string>();
  let fetchedTotal = 0;     // 诊断：scrapeRealtimeMids 抓取总数
  let apiErrors = 0;        // 诊断：API 调用失败次数
  outer: for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page++) {
    for (const kw of SEARCH_KEYWORDS) {
      const ci = batchMids.size % accounts.length;
      try {
        const mids = await scrapeRealtimeMids(accounts[ci].cookie, kw, page);
        fetchedTotal += mids.length;
        for (const m of mids) if (!seen.has(m) && !histMids.has(m)) batchMids.add(m);
      } catch (e) {
        apiErrors++;
        collectorLog.error(`scrapeRealtimeMids失败 keyword="${kw}" page=${page} account=${accounts[ci].nickname}`, e);
      }
      await sleep(500 + Math.random() * 700);
      if (batchMids.size >= CANDIDATE_BATCH) break outer;
    }
    console.log(`  第${page}页轮询完成，本批新增 ${batchMids.size} 个 mid`);
  }
  const mids = [...batchMids];
  console.log(`\n本批候选（去重历史后）: ${mids.length} 个 mid`);

  // ── 检测并标记 cookie 过期的账号 ──
  for (const acc of accounts) {
    if (isCookieExpired(acc.cookie)) {
      await markAccountExpired(acc, '采集搜索时被重定向到登录页');
    }
  }

  // ── 逐条筛选 → 按作者去重 upsert 到池 ──
  const cutoff = Date.now() - 12 * 3600 * 1000;
  let added = 0;
  let filteredScreen = 0;   // 诊断：screenStatus 过滤
  let filteredAuthor = 0;   // 诊断：历史实验已出现过的作者
  for (let i = 0; i < mids.length; i++) {
    const mid = mids[i];
    seen.add(mid);
    const md = await fetchStatusRaw(accounts[i % accounts.length].cookie, mid);
    const sp = screenStatus(md, mid, cutoff);
    if (sp) {
      // 作者级全局去重：历史实验中出现过的作者不再入选
      if (histAuthors.has(String(sp.authorUid))) {
        filteredAuthor++;
        continue;
      }
      // 作者级去重：同一作者只保留一条
      const before = await count(POOL, { experiment_id: experimentId, author_uid: sp.authorUid });
      await upsert(POOL, { experiment_id: experimentId, author_uid: sp.authorUid }, {
        experiment_id: experimentId,
        mid: sp.postId,
        post_url: sp.postUrl,
        content: sp.content,
        author_uid: sp.authorUid,
        author_name: sp.authorName,
        followers: sp.followers,
        comments_count: sp.commentsCount,
        reposts_count: sp.repostsCount,
        likes_count: sp.likesCount,
        published_at: sp.publishedAt,
      });
      if (before === 0) added++;
    } else {
      filteredScreen++;
    }
    await sleep(300 + Math.random() * 600);
    qualified = await count(POOL, { experiment_id: experimentId });
    if ((i + 1) % 50 === 0) console.log(`  进度: ${i + 1}/${mids.length}（池累计 ${qualified}）`);
    if (qualified >= TARGET_QUALIFIED) {
      console.log(`  合格已达标: ${qualified}（本批扫描 ${i + 1} 条）`);
      break;
    }
  }

  qualified = await count(POOL, { experiment_id: experimentId });
  const poolFull = qualified >= TARGET_QUALIFIED;
  await updateOne('experiment_runs', { id: experimentId }, {
    batch_count: (exp.batch_count || 0) + 1,
    pool_full: poolFull,
    seen_mids: [...seen],
  });

  console.log(`\n✅ 本批完成: 新增合格 ${added} 篇，池累计 ${qualified}/${TARGET_QUALIFIED}${poolFull ? '（已达标）' : ''}`);
  collectorLog.log(
    `诊断: 抓取mid=${fetchedTotal} 去重=${mids.length} 筛选通过=${added} 过滤=${filteredScreen} 历史作者=${filteredAuthor} API错误=${apiErrors}`
  );
  return { experimentId, qualified, poolFull };
}

/** 选帖建实验：从候选池选实验帖 + 备选，写 posts / intervention_logs，status → ready */
export async function finalizeExperiment(): Promise<{ experimentId: string } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[选帖建实验] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  // ── QC 暂停检查（规范第十三节）：暂停时跳过建实验，人工恢复后继续 ──
  if (await isQcPaused()) {
    console.log('🚨 QC 暂停中：跳过选帖建实验（检查平台评论处理机制后，人工恢复 qc_state.paused=false）');
    return null;
  }

  const today = new Date().toISOString().split('T')[0];
  const exp = await maybeOne<{ id: string; status: string }>('experiment_runs', { experiment_date: today });
  if (!exp) {
    console.log('❌ 未找到当天实验');
    return null;
  }
  const experimentId = String(exp.id);
  if (exp.status !== 'collecting') {
    console.log(`  当天实验已处于 ${exp.status} 状态，无需重复 finalize`);
    return { experimentId };
  }

  const { rows: poolRows } = await query<{
    id: string; mid: string; post_url: string; content: string;
    author_uid: string; author_name: string; followers: number;
    comments_count: number; reposts_count: number; likes_count: number; published_at: string;
  }>(POOL, { experiment_id: experimentId });
  // 池中为下划线字段，映射回 ScreeningPost（驼峰）供后续分组/写入使用
  const pool: ScreeningPost[] = poolRows.map((r) => ({
    postId: r.mid,
    postUrl: r.post_url,
    content: r.content,
    authorUid: r.author_uid,
    authorName: r.author_name,
    followers: r.followers,
    commentsCount: r.comments_count,
    repostsCount: r.reposts_count,
    likesCount: r.likes_count,
    publishedAt: r.published_at,
  }));
  console.log(`候选池合格帖: ${pool.length} 篇`);

  // ── 全局去重兜底：排除历史实验已出现过的帖子/作者 ──
  const { midSeen: histMids, authorSeen: histAuthors } = await loadHistoryExclusions();
  const filteredPool = pool.filter(
    (p) => !histMids.has(String(p.postId)) && !histAuthors.has(String(p.authorUid)),
  );
  if (filteredPool.length < pool.length) {
    console.log(`⚠️ 全局去重过滤: 池 ${pool.length} → ${filteredPool.length}（排除历史已用帖子/作者）`);
  }

  // ── 作者注册表唯一索引（数据库级并发去重，规范 P0-1）──
  await ensureUniqueIndex(REGISTRY, { platform: 1, post_author_id: 1 });

  // ── 选帖：仅对正式进入随机分组的实验帖原子登记作者（唯一约束冲突 → 跳过该帖并从后续候选补入）──
  // 备选帖此时不登记：待 commenter 回补真正入组时再登记（规范 P0-1 执行原则——只有成功写入注册表的作者才允许入组，
  // 未入组的备选作者不应被提前消耗）
  const shuffled = [...filteredPool].sort(() => Math.random() - 0.5);
  const maxPosts = Math.min(shuffled.length, TARGET_QUALIFIED);
  const maxExp = Math.min(EXPERIMENT_POSTS, Math.floor(maxPosts / 3) * 3);
  const experimentPosts: ScreeningPost[] = [];
  const sparePosts: ScreeningPost[] = [];
  for (const p of shuffled) {
    if (experimentPosts.length + sparePosts.length >= maxPosts) break;
    if (experimentPosts.length < maxExp) {
      if (await tryRegisterAuthor('weibo', p)) {
        experimentPosts.push(p);
      } else {
        console.log(`⚠️ 作者 ${p.authorName} 已登记过实验，跳过其帖子 ${p.postId}`);
      }
    } else {
      sparePosts.push(p);
    }
  }

  // ── 实验帖数：登记后实际可用 ≥3 才可建实验；不足 EXPERIMENT_POSTS 时缩减为最大 3 的倍数并告警 ──
  if (experimentPosts.length < 3) {
    await updateOne('experiment_runs', { id: experimentId }, { status: 'failed', fail_reason: `候选池登记后仅 ${experimentPosts.length} 篇` });
    console.log(`❌ 候选池登记后过少（${experimentPosts.length}），实验标记 failed`);
    return null;
  }
  const expCount = Math.min(EXPERIMENT_POSTS, Math.floor(experimentPosts.length / 3) * 3);
  if (expCount < EXPERIMENT_POSTS) {
    console.log(`⚠️ 告警：登记后可用帖不足 ${EXPERIMENT_POSTS} 篇，缩减实验帖为 ${expCount}（三等分）`);
  }
  const finalExperimentPosts = experimentPosts.slice(0, expCount);
  const unusedRegistered = experimentPosts.slice(expCount); // 已登记但未入组的冗余帖，降级为备选
  const allSparePosts = [...unusedRegistered, ...sparePosts];
  console.log(`实验帖 ${finalExperimentPosts.length} 篇 + 备选 ${allSparePosts.length} 篇`);

  // ── 分组 + 模板 ──
  const { grouped, config } = randomizeAndGroup(finalExperimentPosts as any, expCount);
  const withTemplates = await assignTemplates(grouped as any);

  // 本批次统一计划事件时间（规范 P1-6）：Control/Low/High 三组同批对齐
  const scheduledEventTs = now();

  // ── 写实验帖 + intervention_logs ──
  for (const item of withTemplates) {
    const p = (item as any).post as ScreeningPost;
    const post = await insert<{ id: string }>('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      mid: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: item.group,
      is_spare: false,
      published_at: p.publishedAt,
    });
    if (post) {
      // 登记作者正式入组（规范 P0-1：Control 作者也必须登记）
      await updateOne(REGISTRY, { platform: 'weibo', post_author_id: p.authorUid }, { first_treatment_group: item.group });
    }
    if (post && item.group !== 'control') {
      // High/Low：待发送评论记录（规范第四节：立即保存 robot_comment_id 等字段）
      await insert('intervention_logs', {
        platform: 'weibo',
        experiment_id: experimentId,
        post_id: p.postId,
        post_url: p.postUrl,
        post_author_id: p.authorUid,
        post_group: item.group,
        randomization_timestamp: now(),
        scheduled_event_timestamp: scheduledEventTs,
        send_attempted: 0,
        send_success: 0,
        comment_template: (item as any).templateId ? String((item as any).templateId) : null,
        comment_content: item.commentContent,
        robot_comment_text: item.commentContent,
        status: 'pending',
      });
    } else if (post && item.group === 'control') {
      // Control：pseudo-event 记录（规范第十二节 + P1-6）：不发送评论，
      // pseudo_event_time = 本批次 scheduled_event_timestamp；
      // send_success/robot_comment_id/visibility 均为 NA（null），不是 0（规范建议1）
      await insert('intervention_logs', {
        platform: 'weibo',
        experiment_id: experimentId,
        post_id: p.postId,
        post_url: p.postUrl,
        post_author_id: p.authorUid,
        post_group: 'control',
        randomization_timestamp: now(),
        scheduled_event_timestamp: scheduledEventTs,
        send_attempted: 0,
        send_success: null,
        pseudo_event_timestamp: scheduledEventTs,
        robot_comment_id: null,
        comment_template: null,
        comment_content: '',
        status: 'control',
      });
    }
  }

  // ── 写备选池 ──
  for (const p of allSparePosts) {
    await insert('posts', {
      user_id: 'admin',
      experiment_id: experimentId,
      mid: p.postId,
      post_url: p.postUrl,
      content: p.content,
      author_uid: p.authorUid,
      author_name: p.authorName,
      followers: p.followers,
      comments_count: p.commentsCount,
      reposts_count: p.repostsCount,
      likes_count: p.likesCount,
      post_group: null,
      is_spare: true,
      published_at: p.publishedAt,
    });
  }

  await updateOne('experiment_runs', { id: experimentId }, {
    status: 'ready',
    scheduled_event_timestamp: scheduledEventTs,
    total_posts: finalExperimentPosts.length + allSparePosts.length,
    control_count: config.controlCount,
    low_count: config.lowCount,
    high_count: config.highCount,
  });

  console.log(`\n✅ 实验就绪`);
  console.log(`   experimentId: ${experimentId}`);
  console.log(`   control: ${config.controlCount} | low: ${config.lowCount} | high: ${config.highCount}`);
  console.log(`   待发评论: ${withTemplates.filter((i) => i.group !== 'control').length} 条`);
  console.log(`   备选池: ${sparePosts.length} 篇`);
  return { experimentId };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/collector.ts')) {
  const mode = process.argv[2] || 'batch';
  const run = mode === 'finalize' ? finalizeExperiment : runCollectBatch;
  run()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('采集异常:', e);
      process.exit(1);
    });
}
