/**
 * 正式实验 - 每天 20:00 采 t0 基线 + 发送评论
 * ============================================================================
 * 1. 找当天 status=ready 实验；对其全部 200 帖采 t0 基线（干预前），记录 t0_at
 * 2. 15 账号轮询发送 60 条评论（low30+high30）
 *    - 全账号遍历：从当前轮询位开始，逐个尝试所有可评论账号直到成功
 *    - 备选回补：仍失败则从 is_spare 池取新帖，同样全账号遍历重试
 * 3. 更新实验 status=running
 *
 * 直跑调试：npx tsx src/jobs/commenter.ts [experimentId]
 */

import { query, insert, updateOne, maybeOne } from '../lib/db';
import {
  Account,
  sleep,
  ts,
  now,
  fetchStatusRaw,
  sendOneComment,
  getActiveAccounts,
  getCommentableAccounts,
  markAccountExpired,
  isCookieExpired,
} from './shared';
import { isQcPaused } from './qc';
import { notifySystemAlert } from '../lib/email';

const REGISTRY = 'experiment_author_registry'; // 作者注册表：回补帖作者入组时登记

interface PostRow {
  id: string;
  mid: string;
  post_url?: string;
  post_group: string | null;
  is_spare?: boolean;
  content?: string;
  author_uid?: string;
  author_name?: string;
  followers?: number;
}

interface LogRow {
  id: string;
  post_id: string; // posts 集合的 _id
  post_group: string;
  comment_template: string | null;
  comment_content: string;
  status: string;
}

/** 从错误文案提取错误码（如 retcode:-100），无则返回空串 */
function extractErrorCode(err: string | undefined): string {
  if (!err) return '';
  const m = err.match(/(?:retcode|code)[:：-]?\s*(-?\d+)/i);
  return m ? m[1] : '';
}

/**
 * 发送成功后入队 t0 可见性检查（规范 P0-2）：due=发送后 1-3 分钟，
 * 由后台 visibility-worker 独立执行，不阻塞发送节奏。
 */
/**
 * 回补帖作者正式入组时原子登记（规范 P0-1：只有成功写入注册表的作者才允许入组）：
 *   1. finalize 已预登记（first_treatment_group=null）→ 仅补写组别；
 *   2. 从未登记 → 首次 insert 登记；
 *   3. 已被其他实验占用（组别非空或唯一键冲突）→ 返回 false，调用方跳过该备选帖。
 */
async function registerSpareAuthor(
  platform: string,
  authorUid: string,
  postId: string,
  group: string,
): Promise<boolean> {
  if (!authorUid) return false;
  // 仅当组别仍为 null 时补写（已入组的作者不允许再次入组，不覆盖既有组别）
  const updated = await updateOne(REGISTRY, {
    platform, post_author_id: authorUid, first_treatment_group: null,
  }, { first_treatment_group: group });
  if (updated) return true;
  try {
    await insert(REGISTRY, {
      platform,
      post_author_id: authorUid,
      first_post_id: postId,
      first_treatment_group: group,
      first_randomization_timestamp: now(),
    });
    return true;
  } catch (e: any) {
    if (e?.code === 11000 || /duplicate key/i.test(String(e?.message || ''))) return false;
    throw e;
  }
}

async function enqueueT0Job(logId: string): Promise<void> {
  await insert('visibility_jobs', {
    log_id: logId,
    point: 't0',
    target_check_timestamp: new Date(Date.now() + 60000 + Math.random() * 60000).toISOString(),
    status: 'pending',
    created_at: now(),
  });
}

/**
 * 轮询账号尝试对单帖发评论，最多试 MAX_RETRY 个账号。
 * 同一错误连续失败 → 帖子本身不可评论，提前放弃换帖。
 * @returns { ok, cid, err, usedIdx, allSameErr }
 */
async function tryAllAccounts(
  postId: string,
  content: string,
  accounts: Account[],
  startIdx: number,
): Promise<{ ok: boolean; cid?: string; err?: string; usedIdx: number; allSameErr?: boolean }> {
  const MAX_RETRY = 3; // 最多试 3 个账号，同一错误连续失败就是帖子问题
  let lastErr = '';
  let firstErr = '';
  let allSame = true;
  const limit = Math.min(accounts.length, MAX_RETRY);
  for (let attempt = 0; attempt < limit; attempt++) {
    const acc = accounts[(startIdx + attempt) % accounts.length];
    if (attempt > 0) {
      console.log(`    ⚠️ 失败(${lastErr})，换 @${acc.nickname} 重试 (${attempt + 1}/${limit})`);
      await sleep(2000 + Math.random() * 3000);
    }
    const r = await sendOneComment(postId, content, acc.cookie);
    if (r.ok) {
      return { ok: true, cid: r.cid, usedIdx: (startIdx + attempt) % accounts.length };
    }
    // 检测 cookie 是否过期并立即标记
    if (isCookieExpired(acc.cookie)) {
      await markAccountExpired(acc, `评论失败: ${r.err}`);
    }
    lastErr = r.err || 'unknown';
    if (attempt === 0) {
      firstErr = lastErr;
    } else if (lastErr !== firstErr) {
      allSame = false;
    }
  }
  return { ok: false, err: lastErr, usedIdx: startIdx, allSameErr: allSame };
}

/** 采集单实验全部帖子的 t0 基线快照 */
async function captureBaseline(experimentId: string, accounts: Account[]): Promise<number> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  console.log(`  采集 t0 基线：${posts.length} 帖...`);
  let ok = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const md = await fetchStatusRaw(accounts[i % accounts.length].cookie, p.mid);
    // 检测 cookie 是否过期
    const acc = accounts[i % accounts.length];
    if (isCookieExpired(acc.cookie)) {
      await markAccountExpired(acc, 't0基线采集时被重定向到登录页');
    }
    if (md && md.ok !== 0) {
      await insert('post_snapshots', {
        experiment_id: experimentId,
        post_id: p.mid,
        mid: p.mid,
        time_point: 't0',
        comments_count: md.comments_count || 0,
        reposts_count: md.reposts_count || 0,
        likes_count: md.attitudes_count || 0,
        captured_at: now(),
      });
      ok++;
    }
    await sleep(300 + Math.random() * 500);
    if ((i + 1) % 50 === 0) console.log(`    t0 进度: ${i + 1}/${posts.length}`);
  }
  console.log(`  t0 基线完成: ${ok}/${posts.length}`);
  return ok;
}

export async function runDailyComment(expIdArg?: string): Promise<{ sent: number; failed: number } | null> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[评论发送] 开始  [${ts()}]`);
  console.log(`${'='.repeat(60)}\n`);

  // ── 账号：t0 基线用全部 active（采集不受评论权限限制），发评论用可评论账号 ──
  const allAccounts = await getActiveAccounts();
  if (allAccounts.length === 0) {
    console.log('❌ 没有 active 账号');
    return null;
  }
  const commentAccounts = await getCommentableAccounts();
  if (commentAccounts.length < 2) {
    console.log(`❌ 可评论账号不足（${commentAccounts.length}），跳过发评论（请先运行评论权限检测）`);
    return null;
  }
  console.log(`active 账号: ${allAccounts.length} (采集) | 可评论账号: ${commentAccounts.length} (发评论)`);
  console.log(`可评论: ${commentAccounts.map((a) => a.nickname).join(', ')}`);
  const bannedNames = allAccounts.filter((a) => !commentAccounts.some((c) => c.id === a.id)).map((a) => a.nickname);
  if (bannedNames.length > 0) console.log(`已规避(禁评): ${bannedNames.join(', ')}`);

  // ── 定位当天 ready 实验 ──
  let exp: { id: string; status: string; scheduled_event_timestamp?: string } | null;
  if (expIdArg) {
    exp = await maybeOne('experiment_runs', { id: expIdArg });
  } else {
    const today = new Date().toISOString().split('T')[0];
    exp = await maybeOne('experiment_runs', { experiment_date: today, status: 'ready' });
  }
  if (!exp) {
    console.log('❌ 未找到当天 status=ready 的实验');
    return null;
  }
  const experimentId = String(exp.id);
  console.log(`目标实验: ${experimentId}`);

  // ── t0 基线（评论前）──
  const t0at = now();
  await captureBaseline(experimentId, allAccounts);
  await updateOne('experiment_runs', { id: experimentId }, { t0_at: t0at });

  // ── 待评论日志 ──
  const { rows: logs } = await query<LogRow>('intervention_logs', {
    experiment_id: experimentId,
    status: 'pending',
  });
  console.log(`\n待发送评论: ${logs.length} 条`);

  // ── 备选池（is_spare=true）──
  const { rows: spares } = await query<PostRow>('posts', { experiment_id: experimentId, is_spare: true });
  const sparePool = [...spares];
  console.log(`备选池: ${sparePool.length} 篇\n`);

  let sent = 0;
  let failed = 0;
  let ai = 0; // 账号轮询指针
  let aborted = false;          // 致命错误中止标记

  for (let i = 0; i < logs.length; i++) {
    const log = logs[i];

    // QC 暂停检查（规范建议4）：暂停时立即停止新的干预发送；
    // 已发送 observation 的 monitor / visibility / outcome 抓取继续运行，不受影响
    if (await isQcPaused()) {
      console.log('🚨 QC 暂停中：停止发送新的 High/Low 干预评论（已发送 observation 的监控继续）');
      aborted = true;
      break;
    }

    const post = await maybeOne<PostRow>('posts', { mid: log.post_id });
    if (!post) {
      failed++;
      continue;
    }

    console.log(`[${i + 1}/${logs.length}] ${post.mid} [${log.post_group}] @${commentAccounts[ai % commentAccounts.length].nickname}`);
    // 发送尝试记录（规范第四节：send_attempted + send_attempt_timestamp）
    await updateOne('intervention_logs', { id: log.id }, {
      send_attempted: 1, send_attempt_timestamp: now(),
    });
    const r = await tryAllAccounts(post.mid, log.comment_content, commentAccounts, ai);
    ai = (r.usedIdx + 1) % commentAccounts.length;

    if (r.ok) {
      const usedAccount = commentAccounts[r.usedIdx];
      await updateOne('intervention_logs', { id: log.id }, {
        status: 'sent', comment_id: r.cid, sent_at: now(),
        robot_comment_id: r.cid,
        robot_comment_text: log.comment_content,
        robot_account_id: usedAccount.weibo_uid,
        send_success: 1,
        send_success_timestamp: now(),
        account_nickname: usedAccount.nickname,
        account_uid: usedAccount.weibo_uid,
      });
      sent++;
      console.log(`    ✅ 成功 cid=${r.cid} (${usedAccount.nickname})`);
      // 规范 P0-2：入队 t0 检查（发送后 1-3 分钟由后台 worker 执行），不阻塞发送节奏
      await enqueueT0Job(log.id);
    } else {
      await updateOne('intervention_logs', { id: log.id }, {
        status: 'failed', error: r.err,
        send_success: 0,
        send_error_code: extractErrorCode(r.err),
        send_error_message: r.err,
      });
      failed++;
      console.log(`    ❌ 本帖子不可评论 / 连续3账号同错(${r.err})`);

      // 致命错误立即中止：retcode:-100 = cookie 过期（系统性问题，再试无意义）
      if (r.allSameErr && /\bretcode:-100\b/.test(r.err || '')) {
        console.log(`
🚨 全账号一致报错"${r.err}"（致命：cookie 过期），立即中止评论发送`);
        aborted = true;
        notifySystemAlert('微博', '评论发送全部账号Cookie过期', `连续3个账号均返回 ${r.err}（retcode:-100），已中止发送并保持实验 ready 状态`);
        break;
      }

      // ── 备选循环回补：不停拿备选帖重试，直到成功或池耗尽 ──
      // 注意：allSameErr 也做回补 —— 帖子不让评论是正常现象，换帖即可
      let backfilled = false;
      while (!backfilled && sparePool.length > 0) {
        const spare = sparePool.shift()!;
        const spareIdx = sparePool.length;
        console.log(`    🔄 备选回补(${spareIdx}篇剩余): ${spare.mid} [${spare.author_name}]`);
          try {
            // 回补帖作者正式入组 → 原子登记（规范 P0-1）：已被占用 → 跳过该备选帖
            if (!await registerSpareAuthor('weibo', String(spare.author_uid || ''), spare.mid, log.post_group)) {
              console.log(`    ⚠️ 备选帖作者 ${spare.author_name} 已被占用，跳过该备选帖`);
              continue;
            }
            await updateOne('posts', { id: spare.id }, { is_spare: false, post_group: log.post_group });
            const spareLog = await insert<{ id: string }>('intervention_logs', {
              experiment_id: experimentId,
              post_id: spare.mid,
              post_url: spare.post_url || null,
              post_author_id: spare.author_uid,
              post_group: log.post_group,
              scheduled_event_timestamp: exp.scheduled_event_timestamp || null,
              comment_template: log.comment_template,
              comment_content: log.comment_content,
              robot_comment_text: log.comment_content,
              send_attempted: 1,
              send_attempt_timestamp: now(),
              send_success: 0,
              status: 'pending',
            });
            if (spareLog) {
              const sr = await tryAllAccounts(spare.mid, log.comment_content, commentAccounts, ai);
              ai = (sr.usedIdx + 1) % commentAccounts.length;
              if (sr.ok) {
                const usedAccount2 = commentAccounts[sr.usedIdx];
                await updateOne('intervention_logs', { id: spareLog.id }, {
                  status: 'sent', comment_id: sr.cid, sent_at: now(),
                  robot_comment_id: sr.cid,
                  robot_comment_text: log.comment_content,
                  robot_account_id: usedAccount2.weibo_uid,
                  send_success: 1,
                  send_success_timestamp: now(),
                  account_nickname: usedAccount2.nickname,
                  account_uid: usedAccount2.weibo_uid,
                });
                sent++;
                failed--;
                backfilled = true;
                console.log(`    ✅ 回补成功 cid=${sr.cid}`);
                await enqueueT0Job(spareLog.id);
              } else {
                await updateOne('intervention_logs', { id: spareLog.id }, {
                  status: 'failed', error: sr.err,
                  send_success: 0,
                  send_error_code: extractErrorCode(sr.err),
                  send_error_message: sr.err,
                });
                // 备选也全账号同错 → 系统性故障，停止回补
                if (sr.allSameErr) {
                  console.log(`    🔥 备选回补也全账号同错"${sr.err}"，停止回补循环`);
                  break;
                }
                console.log(`    ❌ 回补失败(${sr.err})，继续尝试下一篇备选...`);
              }
            }
          } catch (e: any) {
            console.log(`    ⚠️ 回补异常: ${e.message}`);
          }
        }
        if (!backfilled) {
          console.log(`    🚫 备选池已耗尽，本条评论最终失败`);
        }
    }
    // 保持原发送节奏（25-35s/条）；t0 检查已解耦到后台 worker，不在此阻塞
    await sleep(25000 + Math.random() * 10000);
  }

  // ── 更新实验状态 ──
  if (!aborted) {
    await updateOne('experiment_runs', { id: experimentId }, { status: 'running' });
  }

  console.log(`\n${aborted ? '⚠️ 评论发送中止（熔断）' : '✅ 评论发送完成'}: 成功 ${sent} / 失败 ${failed}`);
  if (aborted) {
    console.log(`   实验 ${experimentId} status 保持 ready（恢复后重试），t0_at=${t0at}`);
  } else {
    console.log(`   实验 ${experimentId} → status=running，t0_at=${t0at}`);
  }
  return { sent, failed };
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/commenter.ts')) {
  runDailyComment(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('评论异常:', e);
      process.exit(1);
    });
}
