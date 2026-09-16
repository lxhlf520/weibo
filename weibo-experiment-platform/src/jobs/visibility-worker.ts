/**
 * 正式实验 - t0 可见性检查后台 worker（微博，规范 P0-2）
 * ============================================================================
 * commenter 发送成功后只入队 visibility_jobs（due=发送后 1-3 分钟），不阻塞发送节奏。
 * 本 worker 由 scheduler 每 60s 独立触发，执行到期（target_check_timestamp <= now）的 t0 检查：
 *   - 用独立观察账号（role=observer）验证，0 结果由第二个观察账号复核（规范建议3）；
 *   - 检查结果写入 visibility_checks + intervention_logs（writeVisibility 统一落库）；
 *   - 晚于目标时间执行时如实记录 actual_check_timestamp，不伪装准时检查。
 * 与心跳任务互不阻塞：即使 commenter 正在发送，本 worker 也能在 1-3 分钟后执行检查。
 *
 * 直跑调试：npx tsx src/jobs/visibility-worker.ts
 */

import { query, updateOne, maybeOne } from '../lib/db';
import { now, getObserverAccounts } from './shared';
import { checkWeiboVisibilityWithObservers, writeVisibility } from './visibility';

interface JobRow {
  id: string;
  log_id: string;
  target_check_timestamp: string;
  status: string;
}

interface LogRow {
  id: string;
  post_id: string; // 微博 intervention_logs.post_id = mid
  robot_comment_id?: string | null;
}

/** 每次运行最多处理的 job 数（防止观察账号 API 配额瞬时冲击） */
const MAX_JOBS_PER_RUN = 20;

export async function runVisibilityT0Worker(): Promise<number> {
  const { rows: jobs } = await query<JobRow>(
    'visibility_jobs',
    {
      status: 'pending',
      target_check_timestamp: { $lte: new Date().toISOString() },
    },
    { sort: { target_check_timestamp: 1 }, limit: MAX_JOBS_PER_RUN },
  );
  if (jobs.length === 0) return 0;

  const observers = await getObserverAccounts();
  if (observers.length === 0) {
    console.log('  [t0worker] ⚠️ 无观察账号，到期检查将记 NA');
  }

  let done = 0;
  for (const job of jobs) {
    const log = await maybeOne<LogRow>('intervention_logs', { id: job.log_id });
    if (!log || !log.robot_comment_id) {
      // 日志缺失或未真正发送成功 → 直接置 done，避免卡队列
      await updateOne('visibility_jobs', { id: job.id }, {
        status: 'done',
        actual_check_timestamp: now(),
        result: null,
        failure_reason: log ? 'empty robot_comment_id' : 'log missing',
      });
      done++;
      continue;
    }
    try {
      const { result, accountName } = await checkWeiboVisibilityWithObservers(
        observers,
        log.post_id,
        log.robot_comment_id,
        done,
      );
      const label = result.code === 1 ? '可见' : result.code === 0 ? '不可见' : 'NA';
      console.log(`  👁️ t0可见性[${log.post_id}](${accountName || '无观察账号'}): ${label}${result.reason ? ` (${result.reason})` : ''}`);
      await writeVisibility(log.id, 't0', result, accountName, 'buildComments', job.target_check_timestamp);
    } catch (e: any) {
      await writeVisibility(log.id, 't0', { code: null, reason: `exception: ${e.message}`, queryComplete: false }, '', 'buildComments', job.target_check_timestamp);
    }
    await updateOne('visibility_jobs', { id: job.id }, {
      status: 'done',
      actual_check_timestamp: now(),
    });
    done++;
  }

  if (done > 0) console.log(`  [t0worker] 本次完成 ${done} 条 t0 检查`);
  return done;
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/visibility-worker.ts')) {
  runVisibilityT0Worker()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('t0 worker 异常:', e);
      process.exit(1);
    });
}
