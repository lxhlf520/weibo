/**
 * 核查/补抓疑似截断帖子
 * ============================================================================
 * 针对 post_comment_meta 中捕获量 < API total_number 的帖子，
 * 重新拉取全部评论（含回复），补全缺失数据并写入 comment_snapshots。
 *
 * 截断检测逻辑：
 *   1. 解析 post_comment_meta.raw_response 获取旧捕获量
 *   2. 调用 getComments(page=1) 获取 API 的 total_number
 *   3. total_number > 旧捕获量 → 确认截断，重新全量拉取
 *
 * 直跑：npx tsx src/jobs/verify-truncated.ts [experimentId]
 */

import { query, upsert } from '../lib/db';
import { getComments, getAllCommentsWithReplies } from '../lib/weibo-api';
import type { CommentWithParent } from '../lib/weibo-api';
import { Account, sleep, ts, now, getActiveAccounts, fetchStatusRaw } from './shared';

interface PostCommentMeta {
  id: string;
  experiment_id: string;
  post_id: string;
  mid: string;
  post_url: string;
  raw_response: string;
  captured_at: string;
}

interface ExperimentRun {
  id: string;
  status: string;
  t0_at?: string;
}

/** 解析 raw_response 获取旧捕获的顶层评论数（兼容新旧两种格式） */
function parseOldTopLevelCount(rawResponse: string): number {
  try {
    const parsed = JSON.parse(rawResponse);
    // 新格式: { top_level_count, reply_count, total_count, ... }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.top_level_count === 'number') {
        return parsed.top_level_count;
      }
      // 从 comments 数组推算：parent_comment_id === null 的是顶层
      if (Array.isArray(parsed.comments)) {
        return parsed.comments.filter(
          (c: any) => c._parent_comment_id === null || c._parent_comment_id === undefined,
        ).length;
      }
      return 0;
    }
    // 旧格式: 纯数组 [...]
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
  } catch {
    // JSON 解析失败
  }
  return 0;
}

/** 解析 raw_response 获取旧捕获的总评论数 */
function parseOldTotalCount(rawResponse: string): number {
  try {
    const parsed = JSON.parse(rawResponse);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.total_count === 'number') {
        return parsed.total_count;
      }
      if (typeof parsed.top_level_count === 'number' && typeof parsed.reply_count === 'number') {
        return parsed.top_level_count + parsed.reply_count;
      }
      if (Array.isArray(parsed.comments)) {
        return parsed.comments.length;
      }
      return 0;
    }
    if (Array.isArray(parsed)) {
      return parsed.length;
    }
  } catch {}
  return 0;
}

export async function verifyTruncated(experimentId?: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[截断帖子核查/补抓] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    console.log('❌ 没有 active 账号');
    return;
  }
  console.log(`可用账号: ${accounts.length}`);

  // 查询 post_comment_meta
  const filter: Record<string, unknown> = {};
  if (experimentId) filter.experiment_id = experimentId;

  const { rows: metas } = await query<PostCommentMeta>('post_comment_meta', filter);
  console.log(`post_comment_meta 记录: ${metas.length}\n`);

  if (metas.length === 0) {
    console.log('没有需要核查的记录');
    return;
  }

  // 逐条核查
  let processed = 0;
  let truncatedCount = 0;
  let totalNewTopLevel = 0;
  let totalNewReplies = 0;

  for (const meta of metas) {
    const acc = accounts[processed % accounts.length];
    // 旧数据可能缺失 mid，用 post_id 回退
    const mid = meta.mid || meta.post_id;

    try {
      // Step 1: 解析旧数据
      const oldTopLevel = parseOldTopLevelCount(meta.raw_response);
      const oldTotal = parseOldTotalCount(meta.raw_response);

      // Step 2: 获取 API 的 total_number（只拉第一页，轻量）
      const firstPage = await getComments(acc.cookie, mid);
      const apiTotal = firstPage.total;

      // Step 3: 判断是否截断
      if (apiTotal <= oldTopLevel) {
        console.log(`  ✅ ${mid}: ${oldTopLevel}/${apiTotal} 顶层完整`);
        processed++;
        await sleep(200 + Math.random() * 300);
        continue;
      }

      // 确认截断，重新全量拉取
      truncatedCount++;
      const delta = apiTotal - oldTopLevel;
      console.log(`  ⚠️ ${mid}: 旧顶层 ${oldTopLevel} < API ${apiTotal} (缺 ~${delta}), 重新拉取...`);

      // Step 3: 获取帖子作者 UID（子回复翻页需要）并重新全量拉取
      const statusRaw = await fetchStatusRaw(acc.cookie, mid);
      const postUid = statusRaw?.user?.idstr || '';

      const result = await getAllCommentsWithReplies(acc.cookie, mid, postUid, 30);

      const newTopLevel = result.topLevelCount;
      const newReplies = result.replyCount;
      const newTotal = result.all.length;

      // Step 4: 更新 post_comment_meta（用新格式覆盖）
      await upsert(
        'post_comment_meta',
        { experiment_id: meta.experiment_id, post_id: mid },
        {
          experiment_id: meta.experiment_id,
          post_id: mid,
          mid,
          post_url: meta.post_url,
          raw_response: JSON.stringify({
            top_level_count: newTopLevel,
            reply_count: newReplies,
            total_count: newTotal,
            api_total_number: apiTotal,
            comments: result.all.map((item) => ({
              ...item.comment,
              _parent_comment_id: item.parent_comment_id,
              _root_comment_id: item.root_comment_id,
            })),
          }),
          captured_at: now(),
        },
      );

      // Step 5: 写入 comment_snapshots（upsert 保证不重复）
      for (const item of result.all) {
        const c = item.comment;
        await upsert(
          'comment_snapshots',
          { experiment_id: meta.experiment_id, comment_id: c.idstr },
          {
            experiment_id: meta.experiment_id,
            post_id: mid,
            mid,
            comment_id: c.idstr,
            parent_comment_id: item.parent_comment_id,
            root_comment_id: item.root_comment_id,
            author_uid: c.user?.idstr || String(c.user?.id || ''),
            author_name: c.user?.screen_name || '',
            content: c.text_raw || c.text || '',
            likes_count: c.like_counts || 0,
            comment_time: c.created_at || '',
            captured_at: now(),
          },
        );
      }

      // 统计净增
      const deltaTop = newTopLevel - oldTopLevel;
      const deltaReplies = newReplies - Math.max(0, oldTotal - oldTopLevel);
      totalNewTopLevel += Math.max(0, deltaTop);
      totalNewReplies += Math.max(0, deltaReplies);

      console.log(`    → 新: ${newTopLevel} 顶层 + ${newReplies} 回复 = ${newTotal} 总计 (净增: +${Math.max(0, deltaTop)}/+${Math.max(0, deltaReplies)})`);

    } catch (e: any) {
      console.log(`  ❌ ${mid}: ${e.message}`);
    }

    processed++;
    await sleep(500 + Math.random() * 1000);

    if (processed % 20 === 0) {
      console.log(`  进度: ${processed}/${metas.length}, 截断: ${truncatedCount}, 增顶层: ${totalNewTopLevel}, 增回复: ${totalNewReplies}`);
    }
  }

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`✅ 核查完成`);
  console.log(`   处理: ${processed} 帖`);
  console.log(`   截断: ${truncatedCount} 帖`);
  console.log(`   新增顶层评论: ${totalNewTopLevel}`);
  console.log(`   新增回复: ${totalNewReplies}`);
  console.log(`${'─'.repeat(40)}\n`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/verify-truncated.ts')) {
  verifyTruncated(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('异常:', e);
      process.exit(1);
    });
}
