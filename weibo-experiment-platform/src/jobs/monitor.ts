/**
 * 正式实验 - 每 30 分钟 tick 扫描所有 running 实验，按 t0_at 补采到点监控快照
 * ============================================================================
 * 多实验并行：每个实验有独立 t0_at；对每个 running 实验遍历 MONITOR_POINTS，
 * 若 now >= t0_at + offset 且该点不在 completed_points → 采集全部帖快照并标记完成。
 * 幂等：进程重启后按 completed_points 续采，不重复。
 * t72h 全部完成或超期 → status=completed。
 *
 * 直跑调试：npx tsx src/jobs/monitor.ts
 */

import { query, insert, updateOne } from '../lib/db';
import {
  Account,
  ExperimentRun,
  MONITOR_POINTS,
  POINT_OFFSET_HOURS,
  VISIBILITY_POINTS,
  VISIBILITY_OFFSET_HOURS,
  LIFECYCLE_HOURS,
  sleep,
  ts,
  now,
  fetchStatusRaw,
  getActiveAccounts,
  getObserverAccounts,
} from './shared';
import { checkWeiboVisibilityWithObservers, writeVisibility } from './visibility';

interface PostRow {
  id: string;
  mid: string;
}

/** 可见性 pass 扫描的 intervention_logs 行 */
interface VisLogRow {
  id: string;
  experiment_id: string;
  post_id: string;
  post_group: string;
  robot_comment_id?: string | null;
  sent_at?: string;
  [key: string]: unknown;
}

/**
 * 可见性检查 pass（规范第六节）：扫描 sent 评论，对到点的可见性检查点
 * （30m/2h/12h/24h/72h，基于每条评论的 sent_at）用观察账号验证是否仍可见。
 * 检查失败/无观察账号 → 记 NA（不得记 0）。每 tick 限流防止 API 配额冲击。
 * 覆盖 running + 刚 completed（<24h）的实验，避免 t72h 检查在 completed 前未做完而遗漏。
 */
async function runVisibilityPass(): Promise<number> {
  const { rows: activeExps } = await query<ExperimentRun>('experiment_runs', {
    $or: [
      { status: 'running' },
      { status: 'completed', completed_at: { $gte: new Date(Date.now() - 24 * 3600_000).toISOString() } },
    ],
  });
  if (activeExps.length === 0) return 0;

  const observers = await getObserverAccounts();
  const experimentIds = activeExps.map((e) => String(e.id));
  const { rows: sentLogs } = await query<VisLogRow>('intervention_logs', {
    experiment_id: { $in: experimentIds },
    status: 'sent',
    robot_comment_id: { $exists: true, $nin: [null, ''] },
  });
  if (sentLogs.length === 0) return 0;

  const nowMs = Date.now();
  const MAX_CHECKS_PER_TICK = 40;
  let checks = 0;

  for (const log of sentLogs) {
    if (checks >= MAX_CHECKS_PER_TICK) break;
    if (!log.sent_at) continue;
    const sentMs = new Date(log.sent_at).getTime();
    if (isNaN(sentMs)) continue;
    const mid = log.post_id; // 微博 intervention_logs.post_id = mid

    for (const pt of VISIBILITY_POINTS) {
      if (checks >= MAX_CHECKS_PER_TICK) break;
      if (log[`visibility_${pt}`] !== undefined && log[`visibility_${pt}`] !== null) continue; // 已检查
      if (nowMs - sentMs < VISIBILITY_OFFSET_HOURS[pt] * 3600_000) continue; // 未到点

      // crawl_{pt}_success：该帖该监控点帖子快照是否已采集
      const { rows: snap } = await query<{ id: string }>(
        'post_snapshots',
        { experiment_id: log.experiment_id, post_id: mid, time_point: pt },
        { limit: 1 },
      );
      await updateOne('intervention_logs', { id: log.id }, {
        [`crawl_${pt}_success`]: snap.length > 0 ? 1 : 0,
      });

      // 目标检查时间 = sent_at + 该点 offset（写入 visibility_checks 供审计，规范 P0-2/P1-5）
      const targetTs = new Date(sentMs + VISIBILITY_OFFSET_HOURS[pt] * 3600_000).toISOString();

      if (observers.length === 0) {
        await writeVisibility(log.id, pt, { code: null, reason: 'no observer account', queryComplete: false }, '', 'none', targetTs);
        checks++;
        continue;
      }
      // 观察账号检查；首次判 0 时由第二个观察账号复核（规范建议3）
      const { result, accountName } = await checkWeiboVisibilityWithObservers(
        observers,
        mid,
        log.robot_comment_id as string,
        checks,
      );
      const label = result.code === 1 ? '可见' : result.code === 0 ? '不可见' : 'NA';
      console.log(`  👁️ [${log.post_group}] ${mid} ${pt}可见性(${accountName}): ${label}${result.reason ? ` (${result.reason})` : ''}`);
      await writeVisibility(log.id, pt, result, accountName, 'buildComments', targetTs);
      checks++;
      await sleep(300 + Math.random() * 500);
    }
  }

  if (checks > 0) console.log(`  可见性检查完成: 本次 ${checks} 次`);
  return checks;
}

/** 采集指定实验在指定监控点的全部帖快照 */
async function capturePoint(experimentId: string, point: string, accounts: Account[]): Promise<number> {
  const { rows: posts } = await query<PostRow>('posts', { experiment_id: experimentId });
  let ok = 0;
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    const md = await fetchStatusRaw(accounts[i % accounts.length].cookie, p.mid);
    if (md && md.ok !== 0) {
      await insert('post_snapshots', {
        experiment_id: experimentId,
        post_id: p.mid,
        mid: p.mid,
        time_point: point,
        comments_count: md.comments_count || 0,
        reposts_count: md.reposts_count || 0,
        likes_count: md.attitudes_count || 0,
        captured_at: now(),
      });
      ok++;
    }
    await sleep(300 + Math.random() * 500);
  }
  return ok;
}

export async function runMonitorTick(): Promise<void> {
  console.log(`\n[监控 tick] ${ts()}`);

  // 可见性检查 pass（独立于帖子快照流程，running/刚completed 实验都扫）
  try {
    await runVisibilityPass();
  } catch (e) {
    console.error('  可见性检查异常:', e);
  }

  const { rows: running } = await query<ExperimentRun>('experiment_runs', { status: 'running' });
  if (running.length === 0) {
    console.log('  无 running 实验');
    return;
  }
  console.log(`  running 实验: ${running.length} 个`);

  const accounts = await getActiveAccounts();
  if (accounts.length < 2) {
    console.log(`  ⚠️ 可用账号不足（${accounts.length}），跳过本次 tick`);
    return;
  }

  const nowMs = Date.now();

  for (const exp of running) {
    const experimentId = String(exp.id);
    if (!exp.t0_at) {
      console.log(`  [${experimentId}] 无 t0_at，跳过`);
      continue;
    }
    const t0Ms = new Date(exp.t0_at).getTime();
    const completed = new Set(exp.completed_points || []);
    const elapsedH = (nowMs - t0Ms) / 3600_000;

    // 找到所有已到点且未采集的监控点
    const due = MONITOR_POINTS.filter(
      (pt) => !completed.has(pt) && elapsedH >= POINT_OFFSET_HOURS[pt],
    );

    for (const pt of due) {
      console.log(`  [${experimentId}] 采集 ${pt}（已过 ${elapsedH.toFixed(1)}h）...`);
      const ok = await capturePoint(experimentId, pt, accounts);
      completed.add(pt);
      await updateOne('experiment_runs', { id: experimentId }, {
        completed_points: [...completed],
      });
      console.log(`  [${experimentId}] ${pt} 完成: ${ok} 帖`);
    }

    // 生命周期结束判定
    const allDone = MONITOR_POINTS.every((pt) => completed.has(pt));
    if (allDone || elapsedH >= LIFECYCLE_HOURS + 1) {
      await updateOne('experiment_runs', { id: experimentId }, { status: 'completed', completed_at: now() });
      console.log(`  [${experimentId}] ✅ 生命周期结束 → status=completed`);
      // 规范第十三/十一节：终检 QC + 导出 intervention_execution_log.csv
      try {
        const { runQC } = await import('./qc');
        const { exportExperimentCsv } = await import('./export-intervention-csv');
        await runQC(experimentId);
        await exportExperimentCsv(experimentId);
      } catch (e) {
        console.error(`  [${experimentId}] 终检/导出异常:`, e);
      }
    }
  }
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/monitor.ts')) {
  runMonitorTick()
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('监控异常:', e);
      process.exit(1);
    });
}
