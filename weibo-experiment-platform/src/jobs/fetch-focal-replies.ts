/**
 * 抓取实验机器人评论的回复
 * ============================================================================
 * 读取所有成功发送的 focal AI comments（intervention_logs.status='sent'），
 * 按帖子分组，逐帖翻页拉全部顶层评论，匹配 focal comment 后提取内嵌 c.comments。
 *
 * 直跑：npx tsx src/jobs/fetch-focal-replies.ts [experimentId]
 */
import { query, upsert, maybeOne } from '../lib/db';
import { getComments } from '../lib/weibo-api';
import { Account, sleep, ts, now, getActiveAccounts } from './shared';

interface FocalComment {
  id: string;
  post_id: string;
  comment_id: string;
  comment_content: string;
  account_id: string;
  account_nickname: string;
  account_uid?: string;  // 发送评论的微博用户 UID（commenter.ts 写入）
  experiment_id: string;
}

interface PostRow {
  id: string;
  mid: string;
  post_url: string;
  experiment_id: string;
}

export async function fetchFocalReplies(experimentId?: string): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[聚焦评论回复采集] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  if (accounts.length === 0) {
    console.log('❌ 没有 active 账号');
    return;
  }
  console.log(`可用账号: ${accounts.length}`);

  // 读取所有成功发送的 focal comments
  const filter: Record<string, unknown> = { status: 'sent' };
  if (experimentId) filter.experiment_id = experimentId;

  const { rows: focalComments } = await query<FocalComment>('intervention_logs', filter);
  console.log(`成功发送的实验评论: ${focalComments.length} 条\n`);

  if (focalComments.length === 0) {
    console.log('没有可采集的实验评论');
    return;
  }

  // 收集涉及的帖子 & 按帖子分组 focal comments
  const postIds = [...new Set(focalComments.map((f) => f.post_id))];
  const postMap = new Map<string, PostRow>();
  for (const pid of postIds) {
    const post = await maybeOne<PostRow>('posts', { id: pid });
    if (post) postMap.set(pid, post);
  }

  // 按帖子分组
  const focalByPost = new Map<string, FocalComment[]>();
  for (const f of focalComments) {
    const list = focalByPost.get(f.post_id) || [];
    list.push(f);
    focalByPost.set(f.post_id, list);
  }

  // 逐帖翻页采集
  let processedPosts = 0;
  let totalReplies = 0;
  const postEntries = [...focalByPost.entries()];

  for (const [postId, focals] of postEntries) {
    const post = postMap.get(postId);
    if (!post) {
      processedPosts++;
      continue;
    }

    const acc = accounts[processedPosts % accounts.length];
    const focalIdSet = new Set(focals.map(f => f.comment_id));

    try {
      console.log(`\n📋 帖子 ${post.mid}: ${focals.length} 条 focal 评论`);

      // 翻页拉全部顶层评论，匹配 focal 评论后提取内嵌回复
      let maxId: string | undefined;
      let page = 0;
      let postReplies = 0;
      let matchedFocals = 0;

      while (page < 30) {
        const result = await getComments(acc.cookie, post.mid, page + 1, maxId);
        const items = result.comments;

        for (const comment of items) {
          // 检查是否是我们的 focal 评论
          if (focalIdSet.has(comment.idstr)) {
            matchedFocals++;
            const focal = focals.find(f => f.comment_id === comment.idstr);
            if (!focal) continue;

            // 提取内嵌回复
            const inlineReplies = comment.comments || [];
            for (const reply of inlineReplies) {
              await upsert(
                'comment_snapshots',
                { experiment_id: focal.experiment_id, comment_id: reply.idstr },
                {
                  experiment_id: focal.experiment_id,
                  post_id: post.mid,
                  mid: post.mid,
                  comment_id: reply.idstr,
                  parent_comment_id: reply.reply_comment?.id || focal.comment_id,
                  root_comment_id: focal.comment_id,
                  author_uid: reply.user?.idstr || String(reply.user?.id || ''),
                  author_name: reply.user?.screen_name || '',
                  content: reply.text_raw || reply.text || '',
                  likes_count: reply.like_counts || 0,
                  comment_time: reply.created_at || '',
                  captured_at: now(),
                  source: 'focal',
                  focal_comment_id: focal.comment_id,
                },
              );
              postReplies++;
            }
          }
        }

        if (!result.max_id) break;
        maxId = result.max_id;
        page++;
        await sleep(200 + Math.random() * 300);
      }

      totalReplies += postReplies;
      console.log(`  → ${matchedFocals}/${focals.length} focal 匹配, ${postReplies} 条回复 (${page + 1} 页)`);

    } catch (e: any) {
      console.log(`  ❌ ${post.mid}: ${e.message}`);
    }

    processedPosts++;
    await sleep(500 + Math.random() * 1000);

    if (processedPosts % 10 === 0) {
      console.log(`  进度: ${processedPosts}/${postEntries.length} 帖, 累计回复: ${totalReplies}`);
    }
  }

  console.log(`\n✅ 聚焦评论回复采集完成: ${processedPosts} 帖, 累计 ${totalReplies} 条用户回复`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/fetch-focal-replies.ts')) {
  fetchFocalReplies(process.argv[2])
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
