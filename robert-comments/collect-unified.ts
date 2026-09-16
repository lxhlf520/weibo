/**
 * 统一采集：双线程架构（生产者-消费者）
 * 
 * 线程1（采集）：搜索帖子 mid → 放入队列
 * 线程2（判断）：从队列取 mid → 验证罗伯特评论 → 保存
 * 停止逻辑：所有关键词-日期搜索返回空结果（翻不动页了）
 */
import {
  ROBERT_UID,
  PASSIVE_KEYWORDS, ACTIVE_HIGH_HIT_KEYWORDS, SEARCH_KEYWORDS,
  TARGET_ACTIVE, TARGET_PASSIVE,
  now, ts, sleep,
} from './src/config';

// ─── 采集模式 ─────────────────────────────────────────────
// 只采集被动数据（使用 PASSIVE_KEYWORDS）
const COLLECT_MODE: 'passive_only' | 'full' = 'passive_only';
import {
  searchPostMids, buildTimeScope,
  fetchPostRaw, fetchAllCommentsRaw, fetchAllSubCommentsRaw,
  postDelay,
} from './src/weibo-api';
import {
  ensureIndexes, savePassivePost, savePassiveComments,
  saveActivePost, saveActiveComments,
  getSeparateCounts, saveCrawlState, getCrawlState, isPostCollected,
} from './src/db';

// ─── 队列与状态 ─────────────────────────────────────────
interface QueueItem {
  mid: string;
  keyword: string;
  date: string;
  source: 'passive' | 'active';
}

const queue: QueueItem[] = [];
let producerDone = false;
let totalQueued = 0;
let totalProcessed = 0;
let totalFound = 0;

// 队列背压上限：超过后生产者暂停搜索，防止内存无限增长（上次 OOM 教训）
const MAX_QUEUE = 5000;
// 进程内已处理 mid 去重：同一帖被多个关键词/日期命中时只消费一次
const processedMids = new Set<string>();

// ─── 生产者：搜索帖子放入队列 ─────────────────────────────────────────
async function producer() {
  // 根据采集模式选择关键词
  const keywordList = COLLECT_MODE === 'passive_only' 
    ? PASSIVE_KEYWORDS 
    : [...PASSIVE_KEYWORDS, ...ACTIVE_HIGH_HIT_KEYWORDS];
  
  const keywords: { keyword: string; source: 'passive' | 'active' }[] = keywordList.map(k => ({
    keyword: k,
    source: PASSIVE_KEYWORDS.includes(k) ? 'passive' as const : 'active' as const,
  }));

  // 支持环境变量覆盖日期范围（多进程分片用）
  const startDate = process.env.START_DATE || '2023-12-02';
  const endDate = process.env.END_DATE || '2025-04-30';
  const dates = generateDateList(startDate, endDate);

  console.log(`[生产者] 启动: ${keywords.length} 关键词 × ${dates.length} 天`);

  for (const date of dates) {
    for (const { keyword, source } of keywords) {
      try {
        await searchOneScope(keyword, source, date);
      } catch (err) {
        // 单个关键词-日期异常不拖垮整体，记录后继续下一个（断点已保存，重启可续）
        console.error(`[生产者] ${keyword} ${date} 异常，跳过:`, err);
        continue;
      }
      console.log(`[生产者] ${keyword} ${date} 完成`);
    }
  }

  producerDone = true;
  console.log(`[生产者] 完成，总入队: ${totalQueued}`);
}

// 单个 关键词×日期 的搜索翻页（含断点续传 + 深翻页循环去重）
async function searchOneScope(keyword: string, source: 'passive' | 'active', date: string) {
  const timeScope = buildTimeScope(date);
  const stateKey = `unified_${keyword}_${date}`;
  const state = await getCrawlState(stateKey);
  const startPage = (state?.last_page || 0) + 1;

  // 微博搜索超过一定深度后会循环返回重复数据，用 mid 去重 + 连续无新增判定翻页耗尽
  const seenMids = new Set<string>();
  if (startPage > 1) {
    // 续跑场景：先用前几页做种子，避免循环区数据被误判为新数据再次空转
    for (const seedPage of [startPage - 1, startPage - 2, startPage - 3]) {
      if (seedPage < 1) continue;
      const seed = await searchPostMids(keyword, seedPage, timeScope);
      seed.forEach(m => seenMids.add(m));
      await sleep(500);
    }
  }

  let page = startPage;
  let emptyPages = 0;
  let staleStreak = 0; // 连续无新 mid 的页数

  while (true) {
    // 背压：队列积压过多时暂停生产，等消费者消化
    while (queue.length > MAX_QUEUE) {
      await sleep(30000);
    }

    let mids = await searchPostMids(keyword, page, timeScope);

    if (mids.length === 0) {
      emptyPages++;
      if (emptyPages >= 3) {
        // 连续3页空：可能是限流假终止，长退避后复查一次再决定是否停止
        console.log(`[生产者] ${keyword} ${date} 第${page}页 连续空页，退避20s复查...`);
        await sleep(20000);
        mids = await searchPostMids(keyword, page, timeScope);
        if (mids.length === 0) {
          // 确认翻不动了
          break;
        }
        emptyPages = 0;
      } else {
        page++;
        await sleep(1500);
        continue;
      }
    } else {
      emptyPages = 0;
    }

    // 去重：深翻页会循环返回重复数据，只处理新 mid
    const fresh = mids.filter(m => !seenMids.has(m));
    for (const m of fresh) seenMids.add(m);

    if (fresh.length === 0) {
      staleStreak++;
      if (staleStreak >= 10) {
        // 连续10页全是重复数据 → 已进入深翻页循环区，视为翻完
        console.log(`[生产者] ${keyword} ${date} 第${page}页 连续10页全重复，翻页耗尽，停止`);
        break;
      }
    } else {
      staleStreak = 0;
    }

    // 新数据放入队列（去重后）
    for (const mid of fresh) {
      queue.push({ mid, keyword, date, source });
      totalQueued++;
    }

    // 保存断点
    await saveCrawlState(stateKey, { last_page: page });

    page++;
    if (page % 10 === 0) {
      console.log(`[生产者] ${keyword} ${date} 第${page}页  队列: ${queue.length}  总入队: ${totalQueued}`);
    }

    await sleep(800); // 搜索间隔
  }
}

// ─── 消费者：验证罗伯特评论并保存 ─────────────────────────────────────────
async function consumer() {
  console.log('[消费者] 启动');

  while (true) {
    // 等待队列有数据
    while (queue.length === 0) {
      if (producerDone) {
        console.log('[消费者] 生产者已完成且队列为空，退出');
        return;
      }
      await sleep(500);
    }

    // 取一个任务
    const item = queue.shift()!;
    totalProcessed++;

    try {
      await processItem(item);
    } catch (err) {
      console.error(`[消费者] 处理失败 mid=${item.mid}:`, err);
    }

    await postDelay();
  }
}

async function processItem(item: QueueItem) {
  const { mid, keyword, source } = item;

  // 进程内去重：同一 mid 被多个关键词命中时只处理一次
  if (processedMids.has(mid)) return;
  processedMids.add(mid);

  // 已保存过（确认罗伯特评论过）的帖子直接跳过，不重复拉评论
  if (await isPostCollected(mid)) return;

  // 获取帖子详情
  const rawPost = await fetchPostRaw(mid);
  if (!rawPost || rawPost.ok === 0) return;

  const postMid = String(rawPost.idstr || rawPost.id || mid);

  // 检查评论中是否有罗伯特（一级评论翻到底 + 每条一级评论的子评论也翻到底，确保拿全后再判断）
  const commentPages = await fetchAllCommentsRaw(postMid, 150);
  let robertFound = false;

  for (const cp of commentPages) {
    const comments = cp.data || [];
    for (const c of comments) {
      // 检查一级评论
      const uid = String(c.user?.id || c.user?.idstr || '');
      if (uid === ROBERT_UID) {
        robertFound = true;
        break;
      }
      // 检查子评论（全部翻页拿全）
      const totalSubComments = c.total_number || 0;
      if (totalSubComments > 0) {
        const rootId = String(c.id || c.idstr || '');
        const subCommentPages = await fetchAllSubCommentsRaw(postMid, rootId);
        for (const sp of subCommentPages) {
          for (const sc of sp.data || []) {
            const scUid = String(sc.user?.id || sc.user?.idstr || '');
            if (scUid === ROBERT_UID) {
              robertFound = true;
              break;
            }
          }
          if (robertFound) break;
        }
        if (robertFound) break;
        await sleep(200 + Math.random() * 200);
      }
    }
    if (robertFound) break;
  }

  if (!robertFound) return;

  // 罗伯特评论了！检查帖子内容判断主动/被动
  totalFound++;
  const postText = String(rawPost.text || rawPost.title || '').toLowerCase();
  
  const isPassive = PASSIVE_KEYWORDS.some(k => postText.includes(k.toLowerCase()));
  const isActive = ACTIVE_HIGH_HIT_KEYWORDS.some(k => postText.includes(k.toLowerCase()));

  if (isPassive) {
    await savePassivePost(postMid, rawPost);
    for (let i = 0; i < commentPages.length; i++) {
      await savePassiveComments(postMid, i + 1, commentPages[i]);
    }
  }
  
  if (isActive) {
    await saveActivePost(postMid, rawPost);
    for (let i = 0; i < commentPages.length; i++) {
      await saveActiveComments(postMid, i + 1, commentPages[i]);
    }
  }
  
  // 如果都不匹配，默认按关键词来源保存
  if (!isPassive && !isActive) {
    if (source === 'passive') {
      await savePassivePost(postMid, rawPost);
      for (let i = 0; i < commentPages.length; i++) {
        await savePassiveComments(postMid, i + 1, commentPages[i]);
      }
    } else {
      await saveActivePost(postMid, rawPost);
      for (let i = 0; i < commentPages.length; i++) {
        await saveActiveComments(postMid, i + 1, commentPages[i]);
      }
    }
  }

  console.log(`[消费者] ✅ 找到罗伯特评论 mid=${postMid}  累计: ${totalFound}`);
}

// ─── 主函数 ─────────────────────────────────────────
async function main() {
  console.log(`\n[统一采集-双线程] ${ts()}`);
  console.log(`目标: 被动 ${TARGET_PASSIVE} / 主动 ${TARGET_ACTIVE}`);

  await ensureIndexes();

  // 启动双线程
  const producerPromise = producer();
  const consumerPromise = consumer();

  // 定期打印进度
  const progressTimer = setInterval(async () => {
    const counts = await getSeparateCounts();
    const pt = counts.passivePosts + counts.oldPosts;
    console.log(`[进度] 队列: ${queue.length}  已处理: ${totalProcessed}/${totalQueued}  被动: ${pt}  主动: ${counts.activePosts}`);
  }, 60000); // 每分钟

  await Promise.all([producerPromise, consumerPromise]);
  clearInterval(progressTimer);

  const finalCounts = await getSeparateCounts();
  console.log(`\n[统一采集完成]`);
  console.log(`  总入队: ${totalQueued}`);
  console.log(`  总处理: ${totalProcessed}`);
  console.log(`  总找到: ${totalFound}`);
  console.log(`  被动: ${finalCounts.passivePosts + finalCounts.oldPosts}`);
  console.log(`  主动: ${finalCounts.activePosts}`);

  process.exit(0);
}

function generateDateList(start: string, end: string): string[] {
  const dates: string[] = [];
  const cursor = new Date(start);
  const endDate = new Date(end);
  while (cursor <= endDate) {
    dates.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }
  return dates;
}

main().catch(err => {
  console.error('[异常]:', err);
  process.exit(1);
});
