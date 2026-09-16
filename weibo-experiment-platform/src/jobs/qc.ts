/**
 * 正式实验 - 批次级 QC（规范第十三节 + P0-4）
 * ============================================================================
 * 每完成一个 batch，输出 High 与 Low 的 assigned / send_success / visible_t0~72h
 * 全部指标的 numerator / denominator (%)。
 *
 * 暂停判定（规范 P0-4：t0/30m/2h 都独立监控，不只盯 t0）：
 *   对 t0、30m、2h 分别计算 Low−High visibility gap：
 *     - 某点两组样本各累计 ≥50 条后，该点差异 ≥10pp 且连续两个批次触发 → 暂停并汇报
 *     - 任一关键时间点单批差异 ≥20pp → 立即暂停
 *   12h/24h/72h 继续记录与告警（≥20pp 邮件告警），但不触发暂停。
 *   暂停是 QC 规则，不以 p<.05 为条件。
 *   暂停后 finalizeExperiment 跳过新实验、commenter 停止新发送；
 *   已发送 observation 的监控继续。人工恢复：qc_state.paused 改回 false。
 *
 * 直跑调试：npx tsx src/jobs/qc.ts [experimentId]
 */

import { query, maybeOne, upsert } from '../lib/db';
import { notifySystemAlert } from '../lib/email';
import { now } from './shared';

const THRESHOLD_MIN_N = 50;    // 每组可见性样本下限
const WARN_DIFF_PP = 10;       // High 比 Low 低 ≥10pp：连续两批暂停
const CRITICAL_DIFF_PP = 20;   // 单批差异 ≥20pp：立即暂停

/** 关键时间点：参与暂停判定（规范 P0-4） */
const PRIMARY_VIS_METRICS = ['visibility_t0', 'visibility_t30m', 'visibility_t2h'] as const;
/** 次要时间点：仅记录与告警，不触发暂停 */
const SECONDARY_VIS_METRICS = ['visibility_t12h', 'visibility_t24h', 'visibility_t72h'] as const;

interface LogRow {
  post_group?: string;
  send_success?: number;
  visibility_t0?: number | null;
  visibility_t30m?: number | null;
  visibility_t2h?: number | null;
  visibility_t12h?: number | null;
  visibility_t24h?: number | null;
  visibility_t72h?: number | null;
}

const VIS_METRICS = [
  'visibility_t0', 'visibility_t30m', 'visibility_t2h',
  'visibility_t12h', 'visibility_t24h', 'visibility_t72h',
] as const;

interface MetricCell {
  num: number;
  den: number;
}

interface BatchRecord {
  batch_key: string;
  at: string;
  gap_point: string;
  high_rate: number;
  low_rate: number;
  diff_pp: number;
  high_n: number;
  low_n: number;
  flagged: boolean;
  critical: boolean;
}

interface QcState {
  platform: string;
  last_evaluated_batch?: string;
  flag_streak: number;
  last_flagged_point?: string;
  paused: boolean;
  paused_at?: string;
  pause_reason?: string;
  batches: BatchRecord[];
}

/** 聚合单个实验 High/Low 各指标 */
async function aggregateExperiment(
  experimentId: string,
): Promise<Record<string, Record<string, MetricCell>>> {
  const { rows: logs } = await query<LogRow>('intervention_logs', {
    experiment_id: experimentId,
    post_group: { $in: ['high', 'low', 'High', 'Low'] },
  });
  const groups: Record<string, Record<string, MetricCell>> = {};

  for (const g of ['high', 'low']) {
    const gLogs = logs.filter((l) => (l.post_group || '').toLowerCase() === g);
    const cells: Record<string, MetricCell> = {};
    cells.assigned = { num: gLogs.length, den: gLogs.length };
    const sendDen = gLogs.filter((l) => l.send_success !== undefined && l.send_success !== null).length;
    cells.send_success = { num: gLogs.filter((l) => l.send_success === 1).length, den: sendDen };
    for (const m of VIS_METRICS) {
      const checked = gLogs.filter((l) => l[m] === 0 || l[m] === 1);
      cells[m] = { num: checked.filter((l) => l[m] === 1).length, den: checked.length };
    }
    groups[g] = cells;
  }
  return groups;
}

function fmt(c: MetricCell): string {
  if (c.den === 0) return '0/0 (NA)';
  const pct = ((c.num / c.den) * 100).toFixed(1);
  return `${c.num}/${c.den} (${pct}%)`;
}

/** 打印单实验 QC 表 */
function printReport(experimentId: string, groups: Record<string, Record<string, MetricCell>>): void {
  console.log(`\n[QC] 实验 ${experimentId} 批次指标:`);
  console.log(`  组     ${['assigned', 'send_success', ...VIS_METRICS].map((m) => m.padEnd(14)).join('')}`);
  for (const g of ['high', 'low']) {
    const row = ['assigned', 'send_success', ...VIS_METRICS].map((m) => fmt(groups[g][m]).padEnd(14)).join('');
    console.log(`  ${g === 'high' ? 'High' : 'Low '}  ${row}`);
  }
}

async function loadState(): Promise<QcState> {
  const doc = await maybeOne<QcState & { id: string }>('qc_state', { platform: 'weibo' });
  if (doc) return doc;
  const created = await upsert<QcState>('qc_state', { platform: 'weibo' }, {
    platform: 'weibo',
    flag_streak: 0,
    last_flagged_point: '',
    paused: false,
    batches: [],
  });
  return created || { platform: 'weibo', flag_streak: 0, last_flagged_point: '', paused: false, batches: [] };
}

/** 当前是否处于 QC 暂停状态（collector.finalize 检查用） */
export async function isQcPaused(): Promise<boolean> {
  const state = await loadState();
  return state.paused;
}

/** 人工恢复：清除暂停状态 */
export async function resetQcPause(): Promise<void> {
  await upsert('qc_state', { platform: 'weibo' }, {
    platform: 'weibo',
    paused: false,
    flag_streak: 0,
    last_flagged_point: '',
  });
}

/**
 * 运行 QC：聚合指标、打印报告、按阈值判定是否暂停。
 * @param experimentId 指定单个实验；缺省评估所有 running/ready/completed 实验
 */
export async function runQC(experimentId?: string): Promise<void> {
  console.log(`\n[QC] 批次质检  [${now()}]`);

  let exps: { id: string }[];
  if (experimentId) {
    exps = [{ id: experimentId }];
  } else {
    const { rows } = await query<{ id: string }>('experiment_runs', {
      status: { $in: ['running', 'ready', 'completed'] },
    });
    exps = rows;
  }
  if (exps.length === 0) {
    console.log('  无实验可评估');
    return;
  }

  const state = await loadState();
  if (state.paused) {
    console.log('  🚨 当前处于 QC 暂停状态（人工恢复后继续评估）');
    return;
  }

  for (const exp of exps) {
    const experimentId = String(exp.id);
    const groups = await aggregateExperiment(experimentId);
    printReport(experimentId, groups);

    // ── 判定：t0 / 30m / 2h 分别计算 Low−High gap（规范 P0-4），取差距最大的关键时间点 ──
    const gapLines: string[] = [];
    let maxGap = -Infinity;
    let maxGapPoint = '';
    let maxGapHigh: MetricCell | null = null;
    let maxGapLow: MetricCell | null = null;
    for (const m of PRIMARY_VIS_METRICS) {
      const h = groups.high[m];
      const l = groups.low[m];
      gapLines.push(`${m.slice('visibility_'.length)}: High=${fmt(h)} Low=${fmt(l)}`);
      if (h.den < THRESHOLD_MIN_N || l.den < THRESHOLD_MIN_N) continue; // 该点样本不足不参与判定
      const diffPp = (l.num / l.den - h.num / h.den) * 100; // High 比 Low 低为正
      if (diffPp > maxGap) { maxGap = diffPp; maxGapPoint = m; maxGapHigh = h; maxGapLow = l; }
    }
    console.log(`  → 关键时间点差异: ${gapLines.join('  ')}`);
    if (!maxGapHigh || !maxGapLow) {
      console.log(`  → 各关键时间点可见性样本不足（每组阈值 ${THRESHOLD_MIN_N}），暂不判定\n`);
      continue;
    }
    const flagged = maxGap >= WARN_DIFF_PP;
    const critical = maxGap >= CRITICAL_DIFF_PP;
    console.log(`  → ${maxGapPoint}: High=${fmt(maxGapHigh)}, Low=${fmt(maxGapLow)}, diff(Low-High)=${maxGap.toFixed(1)}pp ${critical ? '🔴 临界差异' : flagged ? '🟡 触发阈值' : '✅'}`);

    // 同批去重：只在首次评估该批时更新 streak/暂停状态
    if (experimentId !== state.last_evaluated_batch) {
      state.last_evaluated_batch = experimentId;
      // 连续两批同方向：要求同一关键时间点连续触发（规范 P0-4）
      state.flag_streak = flagged ? (state.last_flagged_point === maxGapPoint ? state.flag_streak + 1 : 1) : 0;
      state.last_flagged_point = flagged ? maxGapPoint : '';

      if (critical || state.flag_streak >= 2) {
        state.paused = true;
        state.paused_at = now();
        state.pause_reason = critical
          ? `单批 ${maxGapPoint} 差异 ${maxGap.toFixed(1)}pp ≥ ${CRITICAL_DIFF_PP}pp`
          : `连续 ${state.flag_streak} 批 High ${maxGapPoint} 比 Low 低 ≥${WARN_DIFF_PP}pp（本批 ${maxGap.toFixed(1)}pp）`;
        console.log(`\n🚨 QC 暂停触发：${state.pause_reason}`);
        console.log(`   后续实验 finalize 将被跳过、commenter 停止发送新干预；请检查平台评论处理机制。`);
        notifySystemAlert(
          '微博',
          'QC 暂停 - High/Low 可见性差异异常',
          `${state.pause_reason}\nHigh=${fmt(maxGapHigh)} Low=${fmt(maxGapLow)}（实验 ${experimentId}）`,
        );
      }

      // 次要时间点（12h/24h/72h）：只记录与告警，不触发暂停（规范 P0-4）
      for (const m of SECONDARY_VIS_METRICS) {
        const h = groups.high[m];
        const l = groups.low[m];
        if (h.den < THRESHOLD_MIN_N || l.den < THRESHOLD_MIN_N) continue;
        const diffPp = (l.num / l.den - h.num / h.den) * 100;
        if (diffPp >= CRITICAL_DIFF_PP) {
          console.log(`  ⚠️ 次要时间点 ${m}: Low-High=${diffPp.toFixed(1)}pp ≥ ${CRITICAL_DIFF_PP}pp（仅告警，不暂停）`);
          notifySystemAlert('微博', 'QC 告警 - 长期可见性差异异常', `${m}: Low-High=${diffPp.toFixed(1)}pp（实验 ${experimentId}）`);
        }
      }

      state.batches.push({
        batch_key: experimentId,
        at: now(),
        gap_point: maxGapPoint,
        high_rate: maxGapHigh.num / maxGapHigh.den,
        low_rate: maxGapLow.num / maxGapLow.den,
        diff_pp: maxGap,
        high_n: maxGapHigh.den,
        low_n: maxGapLow.den,
        flagged,
        critical,
      });
      state.batches = state.batches.slice(-5);
      await upsert('qc_state', { platform: 'weibo' }, state as unknown as Record<string, unknown>);
    }
    console.log('');
  }
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/qc.ts')) {
  runQC(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('QC 异常:', e);
      process.exit(1);
    });
}
