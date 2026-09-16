/**
 * 被动评论采集
 * 策略：搜索 @罗伯特 / 罗伯特 关键词 → 获取帖子原始数据 → 获取评论原始数据
 * 所有数据原封不动存入 MongoDB
 */
import {
  ROBERT_UID,
  SEARCH_KEYWORDS, PASSIVE_KEYWORDS,
  TARGET_ACTIVE, TARGET_PASSIVE,
  ACTIVE_HIGH_HIT_KEYWORDS, ACTIVE_MIN_COMMENTS,
  ACTIVE_WORKERS, ACTIVE_MAX_COMMENT_PAGES,
  ACTIVE_HOTSEARCH_MAX_PAGES,
  ACTIVE_DATE_START, ACTIVE_DATE_END,
  now, ts, sleep,
} from './config';
import {
  searchPostMids, buildTimeScope,
  fetchPostRaw, fetchAllCommentsRaw, fetchUserPostsRaw,
  fetchCommentsRaw, fetchSubCommentsRaw, fetchHotSearchKeywords,
  postDelay,
} from './weibo-api';
import {
  ensureIndexes, savePassivePost, savePassiveComments, saveActivePost, saveActiveComments,
  isPostCollected, getCounts, getSeparateCounts, saveCrawlState, getCrawlState,
} from './db';

// ─── 日期工具 ─────────────────────────────────────────────

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function generateDateList(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + 'T00:00:00');
  const endD = new Date(end + 'T00:00:00');
  while (cur <= endD) {
    dates.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

// ─── 被动采集核心 ─────────────────────────────────────────

interface CollectStats {
  postsNew: number;
  postsCrawled: number;
  commentPagesSaved: number;
}

/**
 * 被动采集：搜索帖子 → 存原始帖子 → 存原始评论
 * @param startDate 开始日期
 * @param endDate 结束日期
 */
export async function collectPassive(
  startDate: string,
  endDate: string,
): Promise<CollectStats> {
  const stats: CollectStats = { postsNew: 0, postsCrawled: 0, commentPagesSaved: 0 };
  const dateRange = `${startDate}~${endDate}`;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[被动采集] ${dateRange}`);
  console.log(`${'='.repeat(60)}\n`);

  await ensureIndexes();

  // ── 阶段 1: 通过关键词搜索发现帖子 ──
  console.log('>>> 阶段 1: 关键词搜索');
  const keywords = [...PASSIVE_KEYWORDS, ...SEARCH_KEYWORDS.slice(0, 20)]; // 被动关键词 + 前20个通用关键词
  const dates = generateDateList(startDate, endDate);

  for (const date of dates) {
    const sepCounts = await getSeparateCounts();
    const passiveTotal = sepCounts.passivePosts + sepCounts.oldPosts;
    console.log(`\n── 日期: ${date}  被动帖子数: ${passiveTotal} ──`);
    if (passiveTotal >= TARGET_PASSIVE) {
      console.log(`✅ 已达到被动目标 ${TARGET_PASSIVE}，停止采集`);
      break;
    }

    const timeScope = buildTimeScope(date);

    for (const keyword of keywords) {
      const sepCounts2 = await getSeparateCounts();
      const passiveTotal2 = sepCounts2.passivePosts + sepCounts2.oldPosts;
      if (passiveTotal2 >= TARGET_PASSIVE) break;

      // 断点续传
      const stateKey = `passive_${keyword}_${date}`;
      const state = await getCrawlState(stateKey);
      const startPage = (state?.last_page || 0) + 1;
      const maxPages = 50;

      let page = startPage;
      let foundThisKeyword = 0;

      while (page <= maxPages) {
        const sepCounts3 = await getSeparateCounts();
        const passiveTotal3 = sepCounts3.passivePosts + sepCounts3.oldPosts;
        if (passiveTotal3 >= TARGET_PASSIVE) break;

        const mids = await searchPostMids(keyword, page, timeScope);
        if (mids.length === 0) {
          if (page === startPage) console.log(`  [${keyword}] 第${page}页无结果`);
          break;
        }

        // 处理每个帖子
        for (const mid of mids) {
          const alreadyCollected = await isPostCollected(mid);
          if (alreadyCollected) continue;

          stats.postsCrawled++;

          // 获取帖子原始数据
          const rawPost = await fetchPostRaw(mid);
          if (!rawPost || rawPost.ok === 0) {
            await postDelay();
            continue;
          }

          const postMid = String(rawPost.idstr || rawPost.id || mid);

          // 获取评论，检查罗伯特是否真的评论了
          const commentPages = await fetchAllCommentsRaw(postMid, 50);
          
          // 检查评论中是否有罗伯特（包括一级评论和子评论）
          let robertFound = false;
          for (const page of commentPages) {
            const comments = page.data || [];
            for (const c of comments) {
              // 检查一级评论
              const uid = String(c.user?.id || c.user?.idstr || '');
              if (uid === ROBERT_UID) {
                robertFound = true;
                break;
              }
              // 检查子评论（如果有）
              const totalSubComments = c.total_number || 0;
              if (totalSubComments > 0) {
                // 获取子评论
                const rootId = String(c.id || c.idstr || '');
                const subCommentPages = await fetchSubCommentsRaw(postMid, rootId);
                if (subCommentPages && subCommentPages.data) {
                  for (const sc of subCommentPages.data) {
                    const scUid = String(sc.user?.id || sc.user?.idstr || '');
                    if (scUid === ROBERT_UID) {
                      robertFound = true;
                      break;
                    }
                  }
                }
                if (robertFound) break;
                await sleep(200 + Math.random() * 200);
              }
            }
            if (robertFound) break;
          }

          // 只有罗伯特真的评论了才保存
          if (!robertFound) {
            await postDelay();
            continue;
          }

          // 保存帖子原始数据（被动采集）
          const isNew = await savePassivePost(postMid, rawPost);
          if (isNew) stats.postsNew++;

          // 保存评论原始数据
          for (let i = 0; i < commentPages.length; i++) {
            await savePassiveComments(postMid, i + 1, commentPages[i]);
            stats.commentPagesSaved++;
          }

          foundThisKeyword++;

          if (stats.postsNew % 100 === 0 && stats.postsNew > 0) {
            const c = await getCounts();
            console.log(`  进度: 帖子 ${c.posts}  评论页 ${c.commentPages}`);
          }

          await postDelay();
        }

        // 保存断点
        await saveCrawlState(stateKey, {
          last_page: page,
          posts_found: foundThisKeyword,
        });

        page++;
        if (page % 10 === 0) {
          const c = await getCounts();
          console.log(`  [${keyword}] 第${page}页  帖子: ${c.posts}  评论页: ${c.commentPages}`);
        }
      }
    }
  }

  // ── 阶段 2: 获取罗伯特自己的微博（补充策略）──
  const sepCounts = await getSeparateCounts();
  const passiveTotal = sepCounts.passivePosts + sepCounts.oldPosts;
  if (passiveTotal < TARGET_PASSIVE) {
    console.log(`\n>>> 阶段 2: 获取罗伯特自己的微博 (被动当前: ${passiveTotal})`);
    const robertStats = await collectRobertPosts();
    stats.postsNew += robertStats.postsNew;
    stats.postsCrawled += robertStats.postsCrawled;
    stats.commentPagesSaved += robertStats.commentPagesSaved;
  }

  const finalCounts = await getCounts();
  console.log(`\n[被动采集完成]`);
  console.log(`  帖子: ${finalCounts.posts}  评论页: ${finalCounts.commentPages}  用户: ${finalCounts.users}`);

  return stats;
}

/**
 * 补充策略：获取罗伯特自己的微博列表，采集评论
 */
async function collectRobertPosts(): Promise<CollectStats> {
  const stats: CollectStats = { postsNew: 0, postsCrawled: 0, commentPagesSaved: 0 };

  const stateKey = `robert_own_posts`;
  const state = await getCrawlState(stateKey);
  const startPage = (state?.last_page || 0) + 1;

  for (let page = startPage; page <= 200; page++) {
    const sepCounts = await getSeparateCounts();
    const passiveTotal = sepCounts.passivePosts + sepCounts.oldPosts;
    if (passiveTotal >= TARGET_PASSIVE) break;

    const rawPosts = await fetchUserPostsRaw(ROBERT_UID, page);
    if (!rawPosts) break;

    const list = rawPosts?.data?.list || rawPosts?.data || [];
    if (!Array.isArray(list) || list.length === 0) break;

    for (const rawPost of list) {
      const mid = String(rawPost.idstr || rawPost.id || rawPost.mblogid || '');
      if (!mid) continue;

      const alreadyCollected = await isPostCollected(mid);
      if (alreadyCollected) continue;

      stats.postsCrawled++;

      // 保存帖子（被动采集）
      await savePassivePost(mid, rawPost);
      stats.postsNew++;

      // 获取评论
      const commentPages = await fetchAllCommentsRaw(mid, 50);
      for (let i = 0; i < commentPages.length; i++) {
        await savePassiveComments(mid, i + 1, commentPages[i]);
        stats.commentPagesSaved++;
      }

      await postDelay();
    }

    await saveCrawlState(stateKey, { last_page: page });

    if (page % 5 === 0) {
      const c = await getCounts();
      console.log(`  罗伯特微博第${page}页  帖子: ${c.posts}  评论页: ${c.commentPages}`);
    }
  }

  return stats;
}

// ─── 主动采集核心 ─────────────────────────────────────────

interface ActiveStats {
  postsChecked: number;   // 检查帖子总数
  highEngagement: number; // 高互动帖子数
  robertFound: number;    // 发现罗伯特的帖子数
  postsNew: number;       // 新保存帖子数
  commentPagesSaved: number;
}

/**
 * 主动采集：高命中关键词 + 热搜 → 不限日期搜索 → 筛选高互动帖子 → 并行检查罗伯特
 * 策略：
 * 1. 高命中类别关键词（个人成就/旅行美食/情感倾诉/宠物萌系）
 * 2. 今天追加热搜关键词
 * 3. 不限日期搜索帖子（罗伯特可评论任何时间的帖子）
 * 4. 筛选评论数 >= 阈值的帖子，并行检查评论中是否有罗伯特
 */
export async function collectActive(
  targetCount: number = 300,
): Promise<ActiveStats> {
  const stats: ActiveStats = {
    postsChecked: 0, highEngagement: 0,
    robertFound: 0, postsNew: 0, commentPagesSaved: 0,
  };

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[主动采集] 目标: ${targetCount} 条`);
  console.log(`  并行 workers: ${ACTIVE_WORKERS}  评论阈值: ${ACTIVE_MIN_COMMENTS}`);
  console.log(`${'='.repeat(60)}\n`);

  await ensureIndexes();

  // ── 构建关键词列表 ──
  const today = fmtDate(new Date());
  console.log('>>> 获取热搜关键词（仅今天适用）');
  const hotKeywords = await fetchHotSearchKeywords();
  console.log(`  热搜: ${hotKeywords.length} 个`);

  // 合并关键词：高命中类别 + 热搜
  const allKeywords = [...new Set([...ACTIVE_HIGH_HIT_KEYWORDS, ...hotKeywords])];
  console.log(`  总关键词: ${allKeywords.length} 个（高命中 ${ACTIVE_HIGH_HIT_KEYWORDS.length} + 热搜 ${hotKeywords.length}）\n`);

  // 全局去重
  const checkedMids = new Set<string>();

  for (const keyword of allKeywords) {
    if (stats.robertFound >= targetCount) break;

    // 断点续传
    const stateKey = `active_${keyword}`;
    const state = await getCrawlState(stateKey);
    const startPage = (state?.last_page || 0) + 1;
    const maxPages = 50; // 每个关键词最多 50 页

    let page = startPage;
    let emptyPages = 0;

    while (page <= maxPages && stats.robertFound < targetCount) {
      // 不限日期搜索
      const mids = await searchPostMids(keyword, page);
      if (mids.length === 0) {
        emptyPages++;
        if (emptyPages >= 2) break;
        page++;
        continue;
      }
      emptyPages = 0;

      // 过滤已检查的 mid
      const newMids = mids.filter(m => !checkedMids.has(m));
      for (const mid of newMids) checkedMids.add(mid);

      if (newMids.length === 0) {
        page++;
        continue;
      }

      // 并行检查帖子
      const results = await parallelCheckPosts(newMids, ACTIVE_WORKERS);

      for (const result of results) {
        stats.postsChecked++;
        if (result.highEngagement) stats.highEngagement++;
        if (result.robertFound) {
          stats.robertFound++;
          const saved = await saveRobertPost(result);
          if (saved) {
            stats.postsNew++;
            stats.commentPagesSaved += result.commentPages.length;
          }
        }
      }

      // 保存断点
      await saveCrawlState(stateKey, { last_page: page });

      if (page % 5 === 0) {
        const rate = stats.postsChecked > 0 ? ((stats.robertFound / stats.postsChecked) * 100).toFixed(1) : '0.0';
        console.log(`  [${keyword}] 第${page}页  检查: ${stats.postsChecked}  罗伯特: ${stats.robertFound}  命中率: ${rate}%`);
      }

      page++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`[主动采集完成]`);
  console.log(`  检查帖子: ${stats.postsChecked}`);
  console.log(`  高互动帖子: ${stats.highEngagement}`);
  console.log(`  发现罗伯特: ${stats.robertFound}`);
  console.log(`  命中率: ${stats.postsChecked > 0 ? ((stats.robertFound / stats.postsChecked) * 100).toFixed(2) : 0}%`);
  console.log(`${'='.repeat(60)}`);

  return stats;
}

/**
 * 并行检查帖子：获取详情 + 筛选高互动 + 检查罗伯特
 */
interface PostCheckResult {
  mid: string;
  highEngagement: boolean;
  robertFound: boolean;
  rawPost: any | null;
  commentPages: any[];
}

async function parallelCheckPosts(
  mids: string[],
  concurrency: number,
): Promise<PostCheckResult[]> {
  const results: PostCheckResult[] = [];
  const queue = [...mids];
  const workers: Promise<void>[] = [];

  for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
    workers.push((async () => {
      while (queue.length > 0) {
        const mid = queue.shift()!;
        const result = await checkSinglePost(mid);
        results.push(result);
      }
    })());
  }

  await Promise.all(workers);
  return results;
}

/**
 * 检查单个帖子：获取详情 → 日期过滤 → 检查罗伯特
 */
async function checkSinglePost(mid: string): Promise<PostCheckResult> {
  const result: PostCheckResult = {
    mid, highEngagement: false, robertFound: false,
    rawPost: null, commentPages: [],
  };

  // 获取帖子详情
  const rawPost = await fetchPostRaw(mid);
  if (!rawPost || rawPost.ok === 0) {
    await postDelay();
    return result;
  }
  result.rawPost = rawPost;

  // 检查帖子发布日期是否在范围内
  const createdAt = rawPost.created_at;
  if (createdAt && !isDateInRange(createdAt, ACTIVE_DATE_START, ACTIVE_DATE_END)) {
    await postDelay();
    return result;
  }

  // 检查评论数
  const commentsCount = rawPost.comments_count || 0;
  if (commentsCount < ACTIVE_MIN_COMMENTS) {
    await postDelay();
    return result;
  }
  result.highEngagement = true;

  // 检查评论中是否有罗伯特（最多翻 ACTIVE_MAX_COMMENT_PAGES 页）
  let maxId: string | undefined;
  for (let p = 0; p < ACTIVE_MAX_COMMENT_PAGES; p++) {
    const rawComments = await fetchCommentsRaw(mid, maxId);
    if (!rawComments) break;

    result.commentPages.push(rawComments);
    const comments = rawComments.data || [];
    if (comments.length === 0) break;

    // 检查是否有罗伯特（包括一级评论和子评论）
    for (const c of comments) {
      // 检查一级评论
      const uid = String(c.user?.id || c.user?.idstr || '');
      if (uid === ROBERT_UID) {
        result.robertFound = true;
        break;
      }
      // 检查子评论（如果有）
      const totalSubComments = c.total_number || 0;
      if (totalSubComments > 0) {
        // 获取子评论
        const rootId = String(c.id || c.idstr || '');
        const subCommentPages = await fetchSubCommentsRaw(mid, rootId);
        if (subCommentPages && subCommentPages.data) {
          for (const sc of subCommentPages.data) {
            const scUid = String(sc.user?.id || sc.user?.idstr || '');
            if (scUid === ROBERT_UID) {
              result.robertFound = true;
              break;
            }
          }
        }
        if (result.robertFound) break;
        await sleep(200 + Math.random() * 200);
      }
    }
    if (result.robertFound) break;

    if (!rawComments.max_id) break;
    maxId = String(rawComments.max_id);
    await sleep(200 + Math.random() * 300);
  }

  await postDelay();
  return result;
}

/**
 * 解析微博日期格式并检查是否在范围内
 * 微博日期格式: "Wed Aug 01 12:00:00 +0800 2026" 或时间戳
 */
function isDateInRange(createdAt: string | number, start: string, end: string): boolean {
  let date: Date;
  if (typeof createdAt === 'number') {
    date = new Date(createdAt);
  } else {
    date = new Date(createdAt);
  }
  if (isNaN(date.getTime())) return false;

  const dateStr = fmtDate(date);
  return dateStr >= start && dateStr <= end;
}

/**
 * 保存发现罗伯特的帖子 + 全部评论（主动采集）
 */
async function saveRobertPost(result: PostCheckResult): Promise<boolean> {
  if (!result.rawPost) return false;

  const postMid = String(result.rawPost.idstr || result.rawPost.id || result.mid);

  // 保存帖子（主动采集）
  await saveActivePost(postMid, result.rawPost);

  // 如果评论页不够，获取全部
  if (result.commentPages.length < 3) {
    const allPages = await fetchAllCommentsRaw(postMid, 50);
    for (let i = 0; i < allPages.length; i++) {
      await saveActiveComments(postMid, i + 1, allPages[i]);
    }
    return true;
  }

  // 保存已获取的评论页
  for (let i = 0; i < result.commentPages.length; i++) {
    await saveActiveComments(postMid, i + 1, result.commentPages[i]);
  }

  // 继续获取剩余评论页
  const lastPage = result.commentPages[result.commentPages.length - 1];
  let maxId = lastPage?.max_id ? String(lastPage.max_id) : undefined;
  if (maxId) {
    for (let p = 0; p < 50; p++) {
      const raw = await fetchCommentsRaw(postMid, maxId);
      if (!raw) break;
      const comments = raw.data || [];
      if (comments.length === 0) break;
      await saveActiveComments(postMid, result.commentPages.length + 1, raw);
      result.commentPages.push(raw);
      if (!raw.max_id) break;
      maxId = String(raw.max_id);
      await sleep(200 + Math.random() * 300);
    }
  }

  return true;
}

// ─── 从已采集评论中提取用户 UID，采集用户信息 ─────────────

/**
 * 用户信息采集：从 raw_comments 中提取评论者 UID，获取用户原始数据
 */
export async function collectUsers(batchSize: number = 1000): Promise<number> {
  console.log(`\n[用户采集] 开始，批次: ${batchSize}`);

  const commentsCol = await (await import('./db')).getCollection('raw_comments');
  const usersCol = await (await import('./db')).getCollection('raw_users');

  // 获取已采集的用户 UID
  const existingUsers = new Set<string>();
  const cursor = usersCol.find({}, { projection: { uid: 1 } });
  for await (const doc of cursor) {
    existingUsers.add(doc.uid);
  }
  console.log(`  已有用户: ${existingUsers.size}`);

  // 从评论中提取 UID（排除罗伯特自己）
  const uidSet = new Set<string>();
  const commentCursor = commentsCol.find({}, { projection: { raw: 1 } }).limit(batchSize * 10);
  let scanned = 0;

  for await (const doc of commentCursor) {
    const comments = doc.raw?.data;
    if (!Array.isArray(comments)) continue;

    for (const c of comments) {
      const uid = String(c.user?.id || c.user?.idstr || '');
      if (uid && uid !== ROBERT_UID && !existingUsers.has(uid)) {
        uidSet.add(uid);
        if (uidSet.size >= batchSize) break;
      }
    }
    scanned++;
    if (uidSet.size >= batchSize) break;
  }

  console.log(`  扫描 ${scanned} 页评论，发现 ${uidSet.size} 个新用户`);

  // 逐个获取用户信息
  let newUsers = 0;
  const { fetchUserRaw } = await import('./weibo-api');
  const { saveRawUser } = await import('./db');

  for (const uid of uidSet) {
    const rawUser = await fetchUserRaw(uid);
    if (rawUser && rawUser.ok === 1 && rawUser.data?.user) {
      await saveRawUser(uid, rawUser.data.user);
      newUsers++;
    }
    await postDelay();

    if (newUsers % 100 === 0 && newUsers > 0) {
      console.log(`  进度: ${newUsers}/${uidSet.size}`);
    }
  }

  const finalCounts = await getCounts();
  console.log(`[用户采集完成] 新增: ${newUsers}  总计: ${finalCounts.users}`);

  return newUsers;
}
