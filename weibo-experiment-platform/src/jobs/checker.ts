/**
 * 正式实验 - 每日评论权限检测（19:30，评论前）
 * ============================================================================
 * 账号会因删评/拉黑被风控禁评，但仍可正常采集帖子。本 job 主动探测每个 active
 * 账号的评论权限，与采集能力分离：
 *   1. 取账号自己最近一条微博 mid
 *   2. 用该账号对自己微博发一条中性测试评论
 *   3. 成功 → can_comment=true，并立即删除该测试评论（近乎无痕）
 *      失败(重试1次仍失败) → can_comment=false + 记录原因
 *   4. 结果写回 accounts（can_comment / comment_checked_at / comment_ban_reason）
 * 采集(collector)仍用全部 active 账号；评论(commenter)只用 can_comment 账号。
 *
 * 直跑调试：npx tsx src/jobs/checker.ts
 */

import { updateOne } from '../lib/db';
import {
  Account,
  PROBE_COMMENTS,
  sleep,
  ts,
  now,
  fetchOwnLatestMid,
  sendOneComment,
  deleteComment,
  getActiveAccounts,
} from './shared';

function pickProbeText(): string {
  return PROBE_COMMENTS[Math.floor(Math.random() * PROBE_COMMENTS.length)];
}

/** 探测单个账号的评论权限 */
async function probeAccount(acc: Account): Promise<{ canComment: boolean; reason: string }> {
  if (!acc.weibo_uid) {
    return { canComment: true, reason: '无 uid，跳过探测（保持原值）' };
  }
  const mid = await fetchOwnLatestMid(acc.cookie, acc.weibo_uid);
  if (!mid) {
    // 无自有微博可探测：保守视为可评论，但记录原因供人工关注
    return { canComment: true, reason: '无自有微博可探测（保守判定可评论）' };
  }

  const text = pickProbeText();
  let r = await sendOneComment(mid, text, acc.cookie);
  if (!r.ok) {
    // 重试 1 次，排除临时抖动
    await sleep(2000 + Math.random() * 2000);
    r = await sendOneComment(mid, text, acc.cookie);
  }

  if (r.ok) {
    // 探测成功 → 删除测试评论
    if (r.cid) {
      const del = await deleteComment(acc.cookie, mid, r.cid);
      if (!del) console.log(`    ⚠️ 测试评论删除失败 cid=${r.cid}（不影响判定）`);
    }
    return { canComment: true, reason: '' };
  }
  return { canComment: false, reason: r.err || '评论失败' };
}

export async function runCommentPermissionCheck(): Promise<{ checked: number; banned: number }> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论权限检测] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  const accounts = await getActiveAccounts();
  console.log(`待检测 active 账号: ${accounts.length}`);

  let checked = 0;
  let banned = 0;
  for (const acc of accounts) {
    const { canComment, reason } = await probeAccount(acc);
    await updateOne('accounts', { id: acc.id }, {
      can_comment: canComment,
      comment_checked_at: now(),
      comment_ban_reason: canComment ? null : reason,
    });
    checked++;
    if (!canComment) banned++;
    const tag = canComment ? '✅ 可评论' : `🚫 禁评(${reason})`;
    console.log(`  [${acc.nickname}] ${tag}`);
    await sleep(3000 + Math.random() * 4000); // 账号间错峰
  }

  console.log(`\n✅ 检测完成: 共 ${checked} 个，禁评 ${banned} 个，可评论 ${checked - banned} 个`);
  return { checked, banned };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/checker.ts')) {
  runCommentPermissionCheck()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('检测异常:', e);
      process.exit(1);
    });
}
