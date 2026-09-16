/**
 * 正式实验 - intervention_execution_log.csv 导出（规范第十一节 + P1-5/P1-6）
 * ============================================================================
 * 一条 randomized post 一行，字段顺序按文档第十一节（新增 scheduled_event_timestamp 列）。
 * null / 缺失字段 → 'NA'（Control 的 robot_comment_id 与 visibility 字段导出为 NA）。
 * notes 列从 visibility_checks 审计表 pivot 出每次检查的账号/结果/失败原因/完整性。
 *
 * 直跑调试：npx tsx src/jobs/export-intervention-csv.ts [experimentId]  # 缺省导出全部实验
 */

import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { query } from '../lib/db';

const CSV_COLUMNS = [
  'platform',
  'post_id',
  'post_author_id',
  'treatment_group',
  'randomization_timestamp',
  'scheduled_event_timestamp',
  'send_attempted',
  'send_attempt_timestamp',
  'send_success',
  'send_success_timestamp',
  'send_failure_reason',
  'robot_account_id',
  'robot_comment_id',
  'robot_comment_text',
  'visibility_t0',
  'visibility_check_t0_timestamp',
  'visibility_30m',
  'visibility_check_30m_timestamp',
  'visibility_2h',
  'visibility_check_2h_timestamp',
  'visibility_12h',
  'visibility_check_12h_timestamp',
  'visibility_24h',
  'visibility_check_24h_timestamp',
  'visibility_72h',
  'visibility_check_72h_timestamp',
  'last_verified_visible_timestamp',
  'first_verified_invisible_timestamp',
  'crawl_30m_success',
  'crawl_2h_success',
  'crawl_12h_success',
  'crawl_24h_success',
  'crawl_72h_success',
  'notes',
] as const;

function escapeCsv(v: string): string {
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/** 任意字段 → CSV 单元格（null/undefined/空 → 'NA'） */
function cell(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'NA';
  return escapeCsv(String(v));
}

/**
 * 导出一个实验的 intervention_execution_log.csv。
 * @returns 导出的文件路径
 */
export async function exportExperimentCsv(experimentId?: string): Promise<string | null> {
  const filter: Record<string, unknown> = experimentId ? { experiment_id: experimentId } : {};
  const { rows } = await query<Record<string, unknown>>('intervention_logs', filter);
  if (rows.length === 0) {
    console.log(`[CSV导出] 无干预记录${experimentId ? `（实验 ${experimentId}）` : ''}，跳过`);
    return null;
  }

  // join visibility_checks 审计表：每次检查的账号/方法/结果/失败原因/完整性（规范 P1-5）
  const logIds = rows.map((r) => String(r.id));
  const { rows: checks } = await query<Record<string, unknown>>('visibility_checks', {
    intervention_log_id: { $in: logIds },
  });
  const checksByLog: Record<string, Record<string, unknown>[]> = {};
  for (const c of checks) {
    const lid = String(c.intervention_log_id);
    if (!checksByLog[lid]) checksByLog[lid] = [];
    checksByLog[lid].push(c);
  }
  const POINT_ORDER = ['t0', 't30m', 't2h', 't12h', 't24h', 't72h'];

  const lines: string[] = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    const notesParts: string[] = [];
    // 每次可见性检查一行审计信息（pivot 进 notes）
    const logChecks = (checksByLog[String(r.id)] || []).sort((a, b) => {
      const ia = POINT_ORDER.indexOf(String(a.point));
      const ib = POINT_ORDER.indexOf(String(b.point));
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
    for (const c of logChecks) {
      const code = c.result === 1 ? '1' : c.result === 0 ? '0' : 'NA';
      let seg = `${c.point}@${c.observer_account_id || '-'}:${code}`;
      if (c.failure_reason) seg += `(${c.failure_reason})`;
      if (c.query_complete === false) seg += '[incomplete]';
      notesParts.push(seg);
    }
    // 旧数据兜底（改造前无 visibility_checks 行的记录）
    if (logChecks.length === 0 && r.visibility_failure_reason) {
      notesParts.push(`visibility_failure_reason=${r.visibility_failure_reason}`);
    }
    if (r.error && r.status === 'failed') notesParts.push(`send_error=${r.error}`);
    if (r.visibility_inconsistency === 1) notesParts.push('visibility_inconsistency=1');
    const line = CSV_COLUMNS.map((col) => {
      switch (col) {
        case 'treatment_group': return cell(r.post_group);
        case 'send_failure_reason': return cell(r.send_error_message);
        case 'notes': return cell(notesParts.join(' | '));
        default: return cell(r[col]);
      }
    }).join(',');
    lines.push(line);
  }

  const outDir = resolve(process.cwd(), 'output');
  mkdirSync(outDir, { recursive: true });
  const suffix = experimentId ? `_${experimentId}` : '_all';
  const filePath = resolve(outDir, `intervention_execution_log${suffix}.csv`);
  writeFileSync(filePath, '\uFEFF' + lines.join('\r\n'), 'utf-8'); // BOM：Excel 中文兼容
  console.log(`[CSV导出] ${rows.length} 行 → ${filePath}`);
  return filePath;
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/export-intervention-csv.ts')) {
  exportExperimentCsv(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('CSV 导出异常:', e);
      process.exit(1);
    });
}
