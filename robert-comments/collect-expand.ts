/**
 * 扩容采集：多通道 × 时间细分（生产者-消费者双线程）
 * 
 * 相对 collect-unified.ts 的扩容点（探测数据支撑，见 config.ts 注释）：
 *   1. L1 核心词按 1 小时段（24 段/天）细分 —— 突破全天查询采样深度限制
 *   2. L1 附加通道：suball=1（含转发）+ xsort=hot（热门排序，独立结果集）
 *   3. L2 新变体词按 6 小时段（4 段/天）细分
 * 
 * 断点前缀 expand_，与旧 unified_ 断点完全隔离（全新通道全新采）
 * 沿用：深翻页去重、空页退避复查、队列背压、Cookie 过期标记
 */
import {
  EXPAND_L1_KEYWORDS, EXPAND_L2_KEYWORDS,
  COOKIES, PC_UA,
  TARGET_PASSIVE,
  ts, sleep,
} from './src/config';

import {
  ensureIndexes, savePassivePost, savePassiveComments,
  getSeparateCounts, saveCrawlState, getCrawlState, isPostCollected,
} from './src/db';
import {
  fetchPostRaw, fetchAllCommentsRaw, fetchAllSubCommentsRaw,
} from './src/weibo-api';
import { ROBERT_UID } from './src/config';

// ─── 通道定义 ─────────────────────────────────────────────
interface Channel {
  id: string;            // 断点前缀
  keyword: string;
  mode: 'realtime' | 'weibo';
  extra: string;         // suball=1 / xsort=hot
  segmentHours: number;  // 24 = 1小时段; 4 = 6小时段
}

function buildChannels(): Channel[] {
  const channels: Channel[] = [];

  // L1 主通道：1 小时段（24 段）
  for (const kw of EXPAND_L1_KEYWORDS) {
    channels.push({ id: 'l1', keyword: kw, mode: 'realtime', extra: '', segmentHours: 24 });
  }
  // L1 含转发：6 小时段（4 段）
  for (const kw of EXPAND_L1_KEYWORDS) {
    channels.push({ id: 'l1sub', keyword: kw, mode: 'realtime', extra: '&suball=1', segmentHours: 4 });
  }
  // L1 热门排序：6 小时段（4 段）
  for (const kw of EXPAND_L1_KEYWORDS) {
    channels.push({ id: 'l1hot', keyword: kw, mode: 'weibo', extra: '&xsort=hot', segmentHours: 4 });
  }
  // L2 新变体词：6 小时段（4 段）
  for (const kw of EXPAND_L2_KEYWORDS) {
    channels.push({ id: 'l2', keyword: kw, mode: 'realtime', extra: '', segmentHours: 4 });
  }

  return channels;
}

// 时段切分：[startHour, endHour] 闭区间
function buildSegments(segmentHours: number): [number, number][] {
  if (segmentHours === 24) {
    return Array.from({ length: 24 }, (_, h) => [h, h] as [number, number]);
  }
  return [[0, 5], [6, 11], [12, 17], [18, 23]];
}

// ─── Cookie 轮换 ─────────────────────────────────────────
let cookieIdx = 0;
const cookieExhausted = new Set<number>();

function getCookie(): string {
  if (COOKIES.length === 0) throw new Error('未配置 WEIBO_COOKIES');
  for (let i = 0; i < COOKIES.length; i++) {
    const idx = (cookieIdx + i) % COOKIES.length;
    if (!cookieExhausted.has(idx)) {
      cookieIdx = (idx + 1) % COOKIES.length;
      return COOKIES[idx];
    }
  }
  throw new Error('所有 Cookie 均已过期');
}

function markCookieExpired(): void {
  const lastIdx = cookieIdx > 0 ? cookieIdx - 1 : COOKIES.length - 1;
  cookieExhausted.add(lastIdx);
  console.log(`[API] Cookie 过期，剩余: ${COOKIES.length - cookieExhausted.size}/${COOKIES.length}`);
  if (cookieExhausted.size >= COOKIES.length) {
    console.error('[API] 所有 Cookie 已耗尽，退出');
    process.exit(2);
  }
}

// ─── 通道搜索（HTML 接口）─────────────────────────────────
// 418 = 微博反爬风控（IP 级）。返回 'RISK' 表示风控阻断（区别于空结果 []）
let risk418Streak = 0;

async function searchChannel(ch: Channel, date: string, seg: [number, number], page: number): Promise<string[] | 'RISK'> {
  const timescope = `custom:${date}-${seg[0]}:${date}-${seg[1]}`;
  const base = ch.mode === 'weibo' ? 'https://s.weibo.com/weibo' : 'https://s.weibo.com/realtime';
  const url = `${base}?q=${encodeURIComponent(ch.keyword)}&page=${page}&timescope=${encodeURIComponent(timescope)}${ch.extra}`;

  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const cookie = getCookie();
      const resp = await fetch(url, {
        headers: {
          'User-Agent': PC_UA,
          'Cookie': cookie,
          'Referer': 'https://s.weibo.com/',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });

      if (resp.url.includes('login.sina.com.cn')) { markCookieExpired(); return []; }

      // 418 风控：IP 级封禁，继续请求只会延长封禁。长冷却重试，连续多次则退出进程
      if (resp.status === 418) {
        risk418Streak++;
        console.log(`[API] 418 风控第 ${risk418Streak} 次，冷却 180s...`);
        await sleep(180000);
        if (risk418Streak >= 6) {
          console.error('[API] 418 持续阻断，进程退出（断点安全，可重启续跑）');
          process.exit(3);
        }
        continue;
      }

      if (resp.status === 403 || resp.status === 429) {
        console.log(`[API] 限流 ${resp.status}，暂停 60s`);
        await sleep(60000);
        continue;
      }
      if (!resp.ok) return [];

      risk418Streak = 0; // 恢复正常
      const html = await resp.text();
      return [...html.matchAll(/mid="(\d+)"/g)].map(m => m[1]);
    } catch {
      if (attempt < 2) { await sleep(2000); continue; }
    }
  }
  return 'RISK';
}

// ─── 队列与状态 ───────────────────────────────────────────
interface QueueItem {
  mid: string;
  channelId: string;
  keyword: string;
  date: string;
}

const queue: QueueItem[] = [];
let producerDone = false;
let totalQueued = 0;
let totalProcessed = 0;
let totalFound = 0;
let totalRequests = 0;

const MAX_QUEUE = 5000;
const processedMids = new Set<string>();

// ─── 生产者：按通道优先级依次扫描 ─────────────────────────
async function producer() {
  const channels = buildChannels();

  // 支持环境变量覆盖日期范围（多进程分片用）
  const startDate = process.env.START_DATE || '2023-12-02';
  const endDate = process.env.END_DATE || '2025-04-30';
  const dates = generateDateList(startDate, endDate);

  const totalScopes = channels.reduce((sum, ch) => sum + dates.length * buildSegments(ch.segmentHours).length, 0);
  console.log(`[生产者] 启动: ${channels.length} 通道 × ${dates.length} 天（共 ${totalScopes} 个 通道×日期×时段 范围）`);

  for (const ch of channels) {
    const segments = buildSegments(ch.segmentHours);
    for (const date of dates) {
      for (const seg of segments) {
        const segKey = ch.segmentHours === 24 ? `h${String(seg[0]).padStart(2, '0')}` : `s${seg[0]}`;
        try {
          await searchOneScope(ch, date, seg, segKey);
        } catch (err) {
          console.error(`[生产者] ${ch.id}|${ch.keyword} ${date} ${segKey} 异常，跳过:`, err);
          continue;
        }
      }
      console.log(`[生产者] ${ch.id}|${ch.keyword} ${date} 完成（${segments.length} 段）`);
    }
  }

  producerDone = true;
  console.log(`[生产者] 完成，总入队: ${totalQueued}, 总请求: ${totalRequests}`);
}

// 单个 通道×日期×时段 的搜索翻页（含断点续传 + 深翻页循环去重）
async function searchOneScope(ch: Channel, date: string, seg: [number, number], segKey: string) {
  const stateKey = `expand_${ch.id}_${ch.keyword}_${date}_${segKey}`;
  const state = await getCrawlState(stateKey);
  const startPage = (state?.last_page || 0) + 1;

  const seenMids = new Set<string>();
  if (startPage > 1) {
    // 续跑场景：用前几页做种子，避免循环区数据被误判为新数据
    for (const seedPage of [startPage - 1, startPage - 2]) {
      if (seedPage < 1) continue;
      const seed = await searchChannel(ch, date, seg, seedPage);
      if (seed === 'RISK') {
        console.log(`[生产者] ${ch.id}|${ch.keyword} ${date} ${segKey} 风控跳过（断点未推进，下次续跑）`);
        return;
      }
      seed.forEach(m => seenMids.add(m));
      await sleep(800);
    }
  }

  let page = startPage;
  let emptyPages = 0;
  let staleStreak = 0;

  while (true) {
    // 背压
    while (queue.length > MAX_QUEUE) {
      await sleep(30000);
    }

    totalRequests++;
    let mids = await searchChannel(ch, date, seg, page);
    if (mids === 'RISK') {
      console.log(`[生产者] ${ch.id}|${ch.keyword} ${date} ${segKey} 风控跳过（断点未推进，下次续跑）`);
      return;
    }

    if (mids.length === 0) {
      emptyPages++;
      if (emptyPages >= 2) {
        // 时段数据量小，连续2页空：短退避复查一次再停
        await sleep(15000);
        const recheck = await searchChannel(ch, date, seg, page);
        if (recheck === 'RISK') {
          console.log(`[生产者] ${ch.id}|${ch.keyword} ${date} ${segKey} 风控跳过（断点未推进，下次续跑）`);
          return;
        }
        if (recheck.length === 0) break;
        mids = recheck;
        emptyPages = 0;
      } else {
        page++;
        await sleep(1000);
        continue;
      }
    } else {
      emptyPages = 0;
    }

    const fresh = mids.filter(m => !seenMids.has(m));
    for (const m of fresh) seenMids.add(m);

    if (fresh.length === 0) {
      staleStreak++;
      if (staleStreak >= 6) {
        // 时段内深翻页循环（时段数据量小，6页全重复即判定耗尽）
        break;
      }
    } else {
      staleStreak = 0;
    }

    for (const mid of fresh) {
      queue.push({ mid, channelId: ch.id, keyword: ch.keyword, date });
      totalQueued++;
    }

    await saveCrawlState(stateKey, { last_page: page });

    page++;
    // 时段深度小，6页打点
    if (page % 6 === 0) {
      console.log(`[生产者] ${ch.id}|${ch.keyword} ${date} ${segKey} 第${page}页  队列: ${queue.length}  总入队: ${totalQueued}`);
    }

    await sleep(6000); // 搜索间隔（418 风控后降速：600→6000，全局≈48请求/分钟）
  }
}

// ─── 消费者：并发验证罗伯特评论并保存（被动）─────────────
// 2026-09-14 418 风控后降速：并发 3→2，间隔上调
const CONSUMER_WORKERS = 2;

async function consumer() {
  console.log(`[消费者] 启动 x${CONSUMER_WORKERS}`);
  await Promise.all(Array.from({ length: CONSUMER_WORKERS }, () => consumerLoop()));
  console.log('[消费者] 全部退出');
}

async function consumerLoop() {
  while (true) {
    while (queue.length === 0) {
      if (producerDone) return;
      await sleep(500);
    }

    const item = queue.shift()!;
    totalProcessed++;

    try {
      await processItem(item);
    } catch (err) {
      console.error(`[消费者] 处理失败 mid=${item.mid}:`, err);
    }

    await sleep(600 + Math.random() * 400);
  }
}

async function processItem(item: QueueItem) {
  const { mid } = item;

  if (processedMids.has(mid)) return;
  processedMids.add(mid);

  if (await isPostCollected(mid)) return;

  const rawPost = await fetchPostRaw(mid);
  if (!rawPost || rawPost.ok === 0) return;

  // 无评论的帖子不可能是罗伯特评论过的，直接跳过（省一次评论请求）
  if ((rawPost.comments_count || 0) === 0) return;

  const postMid = String(rawPost.idstr || rawPost.id || mid);

  // 验证评论中是否有罗伯特（一级评论翻到底 + 子评论翻到底）
  const commentPages = await fetchAllCommentsRaw(postMid, 150);
  let robertFound = false;

  for (const cp of commentPages) {
    const comments = cp.data || [];
    for (const c of comments) {
      const uid = String(c.user?.id || c.user?.idstr || '');
      if (uid === ROBERT_UID) { robertFound = true; break; }
      const totalSubComments = c.total_number || 0;
      if (totalSubComments > 0) {
        const rootId = String(c.id || c.idstr || '');
        const subCommentPages = await fetchAllSubCommentsRaw(postMid, rootId);
        for (const sp of subCommentPages) {
          for (const sc of sp.data || []) {
            const scUid = String(sc.user?.id || sc.user?.idstr || '');
            if (scUid === ROBERT_UID) { robertFound = true; break; }
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

  // 罗伯特评论了 → 按被动保存
  totalFound++;
  await savePassivePost(postMid, rawPost);
  for (let i = 0; i < commentPages.length; i++) {
    await savePassiveComments(postMid, i + 1, commentPages[i]);
  }

  console.log(`[消费者] ✅ 找到罗伯特评论 mid=${postMid}  累计: ${totalFound}`);
}

// ─── 主函数 ─────────────────────────────────────────────
async function main() {
  console.log(`\n[扩容采集-多通道细分] ${ts()}`);
  console.log(`目标: 被动 ${TARGET_PASSIVE}`);

  await ensureIndexes();

  const producerPromise = producer();
  const consumerPromise = consumer();

  const progressTimer = setInterval(async () => {
    const counts = await getSeparateCounts();
    const pt = counts.passivePosts + counts.oldPosts;
    console.log(`[进度] 队列: ${queue.length}  已处理: ${totalProcessed}/${totalQueued}  总请求: ${totalRequests}  被动: ${pt}`);
  }, 60000);

  await Promise.all([producerPromise, consumerPromise]);
  clearInterval(progressTimer);

  const finalCounts = await getSeparateCounts();
  console.log(`\n[扩容采集完成]`);
  console.log(`  总入队: ${totalQueued}`);
  console.log(`  总处理: ${totalProcessed}`);
  console.log(`  总找到: ${totalFound}`);
  console.log(`  总请求: ${totalRequests}`);
  console.log(`  被动: ${finalCounts.passivePosts + finalCounts.oldPosts}`);

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
