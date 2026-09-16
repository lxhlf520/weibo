/**
 * 正式实验 - 评论数据采集与分析（微博适配版）
 * ============================================================================
 * 产出四张溯源表（4 张结果表均来源于此）：
 *   1. post_detail          - 帖子详情原始 API 响应（溯源）
 *   2. post_comment_meta    - 全部评论 API 原始响应（溯源）
 *   3. post_user_meta       - 评论用户信息 API 原始响应（溯源）
 *   4. comment_snapshots    - 结构化评论快照（支持构建评论树）
 *
 * 失败追踪：失败帖子写入 collection_errors，成功则清除。
 * retryOnly=true 时只重试 collection_errors 中的帖子。
 *
 * 直跑调试：npx tsx src/jobs/analyzer.ts [experimentId]           # 全量采集
 *          npx tsx src/jobs/analyzer.ts [experimentId] retry     # 仅重试失败
 */

import { query, upsert, maybeOne, deleteOne } from '../lib/db';
import { getAllComments, getAllCommentsWithReplies, getUserProfile } from '../lib/weibo-api';
import type { WeiboComment } from '../lib/weibo-api';
import {
  Account,
  fetchStatusRaw,
  sleep,
  ts,
  now,
  getActiveAccounts,
} from './shared';

interface PostRow {
  id: string;
  mid: string;
  post_url: string;
  experiment_id: string;
  author_uid?: string;
}

interface ExperimentRun {
  id: string;
  status: string;
  t0_at?: string;
}

/** 提取评论的父评论 ID（微博用 rootidstr + reply_comment.id 判断） */
function getParentCommentId(c: WeiboComment): string | null {
  // 优先使用 API 返回的 reply_comment.id（精确到具体被回复的评论）
  if (c.reply_comment?.id) return c.reply_comment.id;
  // 回退：rootidstr 表示该评论所属的根评论
  if (c.rootidstr && c.rootidstr !== c.idstr) return c.rootidstr;
  return null;
}

/** 采集单个帖子的评论数据 */
async function collectPostComments(
  experimentId: string,
  post: PostRow,
  cookie: string,
): Promise<{ comments: number; replies: number; users: number }> {
  // ── post_detail：保存帖子详情原始响应 ──
  const statusRaw = await fetchStatusRaw(cookie, post.mid);
  const postUid = statusRaw?.user?.idstr || '';
  if (statusRaw) {
    await upsert(
      'post_detail',
      { experiment_id: experimentId, post_id: post.mid },
      {
        experiment_id: experimentId,
        post_id: post.mid,
        mid: post.mid,
        post_url: post.post_url,
        raw_response: JSON.stringify(statusRaw),
        captured_at: now(),
      },
    );
  }

  // ── 读取该帖机器人评论（规范第九节：OP 是否直接回复 Robert 的判定基准）──
  const { rows: robotLogs } = await query<{ robot_comment_id?: string; sent_at?: string }>(
    'intervention_logs',
    { experiment_id: experimentId, post_id: post.mid, status: 'sent' },
    { projection: { robot_comment_id: 1, sent_at: 1 } },
  );
  const robot = robotLogs[0] || null;
  const robotCid = robot?.robot_comment_id || null;
  const robotTs = robot?.sent_at || null;
  // 帖子作者 ID：优先 statusRaw（同源），回退 posts.author_uid
  const postAuthorUid = postUid || post.author_uid || '';

  // ── 获取全部评论（含完整回复链，子回复通过 fetch_level=1 翻页）──
  const result = await getAllCommentsWithReplies(cookie, post.mid, postUid, 30);
  const allItems = result.all;

  // ── post_comment_meta：保存评论原始响应 ──
  if (allItems.length > 0) {
    await upsert(
      'post_comment_meta',
      { experiment_id: experimentId, post_id: post.mid },
      {
        experiment_id: experimentId,
        post_id: post.mid,
        mid: post.mid,
        post_url: post.post_url,
        raw_response: JSON.stringify({
          top_level_count: result.topLevelCount,
          reply_count: result.replyCount,
          total_count: allItems.length,
          comments: allItems.map((item) => ({
            ...item.comment,
            _parent_comment_id: item.parent_comment_id,
            _root_comment_id: item.root_comment_id,
          })),
        }),
        captured_at: now(),
      },
    );
  }

  // ── comment_snapshots：结构化评论数据（包含完整 parent_comment_id）──
  const seenUsers = new Set<string>();
  let topLevelCount = 0;
  let replyCount = 0;

  for (const item of allItems) {
    const c = item.comment;
    const parentId = item.parent_comment_id;
    const rootId = item.root_comment_id;

    if (parentId === null) {
      topLevelCount++;
    } else {
      replyCount++;
    }

    // ── OP 直接回复 Robert 识别（规范第九节）：
    // parent_id == robot_comment_id AND comment_user_id == post_author_id AND created_at > robot_timestamp
    const uid = c.user?.idstr || String(c.user?.id || '');
    let opDirectReply = 0;
    if (
      robotCid && parentId === robotCid
      && uid && postAuthorUid && uid === postAuthorUid
      && robotTs && c.created_at
      && new Date(c.created_at).getTime() > new Date(robotTs).getTime()
    ) {
      opDirectReply = 1;
    }

    await upsert(
      'comment_snapshots',
      { experiment_id: experimentId, comment_id: c.idstr },
      {
        experiment_id: experimentId,
        post_id: post.mid,
        mid: post.mid,
        comment_id: c.idstr,
        parent_comment_id: parentId,
        root_comment_id: rootId,
        author_uid: uid,
        author_name: c.user?.screen_name || '',
        content: c.text_raw || c.text || '',
        likes_count: c.like_counts || 0,
        comment_time: c.created_at || '',
        op_direct_reply: opDirectReply,
        captured_at: now(),
      },
    );

    // 记录去重后的用户
    if (uid && !seenUsers.has(uid)) {
      seenUsers.add(uid);
      const profile = await getUserProfile(cookie, uid);
      if (profile) {
        await upsert(
          'post_user_meta',
          { experiment_id: experimentId, user_id: uid },
          {
            experiment_id: experimentId,
            user_id: uid,
            raw_response: JSON.stringify(profile),
            captured_at: now(),
          },
        );
      }
    }
  }

  console.log(`    ${post.mid}: ${topLevelCount} 顶层 + ${replyCount} 回复`);

  return { comments: topLevelCount, replies: replyCount, users: seenUsers.size };
}

/** 对单个实验的所有帖子采集评论数据 */
async function collectExperiment(
  experimentId: string,
  accounts: Account[],
  retryOnly: boolean,
): Promise<{ posts: number; totalComments: number; totalReplies: number; totalUsers: number }> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  if (!posts.length) {
    console.log('  无帖子，跳过');
    return { posts: 0, totalComments: 0, totalReplies: 0, totalUsers: 0 };
  }

  // retryOnly 模式：只处理 collection_errors 中的帖子
  let targetPostIds: Set<string> | null = null;
  if (retryOnly) {
    const { rows: errors } = await query<{ post_id: string }>(
      'collection_errors',
      { experiment_id: experimentId },
    );
    if (errors.length === 0) {
      console.log(`  无需重试（collection_errors 为空）`);
      return { posts: 0, totalComments: 0, totalReplies: 0, totalUsers: 0 };
    }
    targetPostIds = new Set(errors.map((e) => e.post_id));
    console.log(`  重试模式: ${targetPostIds.size} 帖待重试`);
  }

  let totalComments = 0;
  let totalReplies = 0;
  let totalUsers = 0;
  let processed = 0;

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];

    // retryOnly 模式下跳过不在错误列表中的帖子
    if (targetPostIds && !targetPostIds.has(post.mid)) {
      continue;
    }

    const acc = accounts[processed % accounts.length];
    try {
      const { comments, replies, users } = await collectPostComments(experimentId, post, acc.cookie);
      totalComments += comments;
      totalReplies += replies;
      totalUsers += users;
      // 采集成功，清除之前的失败记录
      await deleteOne('collection_errors', { experiment_id: experimentId, post_id: post.mid });
    } catch (e: any) {
      console.log(`    ⚠️ ${post.mid} 评论采集失败: ${e.message}`);
      // 记录失败，供后续重试
      const { rows: existing } = await query<{ retry_count: number }>(
        'collection_errors',
        { experiment_id: experimentId, post_id: post.mid },
      );
      const retryCount = existing.length > 0 ? (existing[0].retry_count || 0) + 1 : 0;

      await upsert(
        'collection_errors',
        { experiment_id: experimentId, post_id: post.mid },
        {
          experiment_id: experimentId,
          post_id: post.mid,
          mid: post.mid,
          error_msg: (e.message || String(e)).slice(0, 200),
          retry_count: retryCount,
          last_error_at: now(),
        },
      );
    }

    processed++;
    await sleep(500 + Math.random() * 1000);
    if (processed % 20 === 0) {
      const label = retryOnly ? '重试' : '评论采集';
      console.log(`    ${label}进度: ${processed}帖 (评论:${totalComments}, 回复:${totalReplies}, 用户:${totalUsers})`);
    }
  }

  return { posts: processed, totalComments, totalReplies, totalUsers };
}

export async function runAnalyzer(expIdArg?: string, retryOnly = false): Promise<void> {
  const modeLabel = retryOnly ? '重试模式（仅失败帖子）' : '全量采集';
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论数据采集] ${modeLabel} 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`❌ 可用账号不足（${accounts.length}），至少需要 2 个`);
    return;
  }
  console.log(`可用账号: ${accounts.length}`);

  let experiments: ExperimentRun[];

  if (expIdArg && !['retry', 'true', '1'].includes(expIdArg.toLowerCase())) {
    const exp = await maybeOne<ExperimentRun>('experiment_runs', { id: expIdArg });
    experiments = exp ? [exp] : [];
  } else {
    const { rows } = await query<ExperimentRun>('experiment_runs', {
      status: { $in: ['running', 'ready'] },
    });
    experiments = rows;
  }

  if (!experiments.length) {
    console.log('❌ 未找到 running/ready 状态的实验');
    return;
  }
  console.log(`目标实验: ${experiments.length} 个\n`);

  for (const exp of experiments) {
    const experimentId = String(exp.id);
    console.log(`[${experimentId}] 开始采集评论数据...`);
    const { posts, totalComments, totalReplies, totalUsers } = await collectExperiment(
      experimentId, accounts, retryOnly,
    );
    console.log(`[${experimentId}] 完成: ${posts} 帖, ${totalComments} 条评论 + ${totalReplies} 条回复, ${totalUsers} 个用户\n`);
    await sleep(2000);
  }

  console.log(`✅ 评论数据采集完成`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/analyzer.ts')) {
  const arg0 = process.argv[2];
  const isRetry = arg0 === 'retry' || process.argv[3] === 'retry';
  const expId = isRetry ? (arg0 !== 'retry' ? arg0 : undefined) : arg0;
  runAnalyzer(expId, isRetry)
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('分析异常:', e);
      process.exit(1);
    });
}
