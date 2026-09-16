/**
 * 正式实验 - 常驻调度器（Node 原生定时，零外部依赖）
 * ============================================================================
 * 实验生命周期：
 *   14:00                  getOrCreateCollectingExp  提前创建当天实验记录
 *   14:00 / 16:00 / 18:00  runCollectBatch            每 2 小时采一批 2000 候选追加池，
 *                          跨批筛选累计；合格 ≥90 即停后续批次。
 *   18:00 批次采完后        finalizeExperiment        从池选 90 实验帖建实验
 *   20:00                  → runDailyComment          采 t0 基线 + 发评论
 *   每 30 分钟              runMonitorTick            扫描 running 实验补采到点快照
 *
 * 用每分钟一次的 setInterval 心跳判断整点触发（当天每个整点仅一次）。
 * 各任务 try/catch 隔离，串行不重叠。
 *
 * 启动：npx tsx src/jobs/scheduler.ts
 */

import { runCollectBatch, finalizeExperiment, getOrCreateCollectingExp } from './collector';
import { runDailyComment } from './commenter';
import { runMonitorTick } from './monitor';
import { runVisibilityT0Worker } from './visibility-worker';
import { runCommentPermissionCheck } from './checker';
import { runDailyCookieCheck } from './daily-checker';
import { runAnalyzer } from './analyzer';
import { runRetryCollector } from './retry-collector';
import { runQC } from './qc';
import { ensureTemplates } from '../lib/seed-templates';
import { runStartupMigration } from '../lib/startup-migration';
import { closeDb } from '../lib/db';
import { COLLECT_HOURS, ts } from './shared';
import { schedulerLog } from '../lib/logger';
import { notifySystemAlert } from '../lib/email';

const CREATE_HOUR = 14; // 14:00 提前 2h 创建当天实验
const COOKIE_TEST_HOUR = 15; // 15:00 提前 1h 检测账号 cookie 有效性
const COMMENT_HOUR = 20; // 20:00 批次采完后 finalize + 评论
const CHECK_HOUR = 19;
const CHECK_MINUTE = 30; // 19:30 评论权限检测
const COOKIE_CHECK_HOUR = 3; // 3:00 每日 cookie 有效性巡检
const MONITOR_INTERVAL_MIN = 30; // 每 30 分钟监控一次
const ANALYZER_INTERVAL_MIN = 120; // 每 2 小时采集评论数据（仅空闲时段）
const RETRY_HOURS = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21, 23]; // 奇数小时空闲重试

// 实验运行窗口 14:00-20:00：此期间不跑 analyzer，优先保证实验 pipeline 的 API 配额和资源
const EXPERIMENT_WINDOW_START = Math.min(...COLLECT_HOURS);  // 14
const EXPERIMENT_WINDOW_END = COMMENT_HOUR;                   // 20（含）

let busy = false; // 防止长任务重叠
const firedHours = new Map<string, Set<number>>(); // 日期 → 已触发的整点集合
let lastMonitorMinute = -1;
let checkedCommentPermToday = ''; // 当天已检测日期字符串
let checkedCookieToday = ''; // 当天已 cookie 巡检日期字符串
let createdExperimentToday = ''; // 当天已创建实验日期字符串
let checkedCookieBeforeCollectToday = ''; // 当天采集前已 cookie 检测日期字符串
let lastAnalyzerMinute = -1;

async function guarded(name: string, fn: () => Promise<unknown>): Promise<void> {
  if (busy) {
    console.log(`[调度] ${name} 跳过（有任务运行中）  [${ts()}]`);
    return;
  }
  busy = true;
  try {
    await fn();
  } catch (e) {
    schedulerLog.error(`[调度] ${name} 异常`, e);
  } finally {
    busy = false;
  }
}

function dateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 判断某整点当天是否已触发过，未触发则记录并返回 true */
function claimHour(today: string, hour: number): boolean {
  let set = firedHours.get(today);
  if (!set) {
    set = new Set();
    firedHours.set(today, set);
    // 简单清理：只保留当天
    for (const k of firedHours.keys()) if (k !== today) firedHours.delete(k);
  }
  if (set.has(hour)) return false;
  set.add(hour);
  return true;
}

/** 20:00 批次：采集 → 选帖建实验 → 发评论（串行） */
async function runCommentPipeline(): Promise<void> {
  await runCollectBatch(); // 20 点这批补采（若已达标内部会跳过采集）
  const fin = await finalizeExperiment();
  if (fin) {
    await runDailyComment(fin.experimentId);
    // 规范第十三节：发送完成后跑批次 QC（send_success + visible_t0 已齐）
    try { await runQC(fin.experimentId); } catch (e) { schedulerLog.error('[QC] 发送后质检异常', e); }
  }
}

async function heartbeat(): Promise<void> {
  const nowDate = new Date();
  const today = dateStr(nowDate);
  const hour = nowDate.getHours();
  const minute = nowDate.getMinutes();

  // 14:00 提前 2h 创建当天实验（每天一次，整点后 30min 窗口内）
  if (hour === CREATE_HOUR && minute < MONITOR_INTERVAL_MIN && today !== createdExperimentToday) {
    await guarded('14:00 创建实验', async () => {
      createdExperimentToday = today;
      const exp = await getOrCreateCollectingExp();
      console.log(exp ? `✅ 当天实验已就绪 id=${exp.id}` : '⚠️ 当天实验已存在或创建失败');
    });
  }

  // 15:00 提前 1h 检测账号 cookie 有效性（每天一次）
  if (hour === COOKIE_TEST_HOUR && minute === 0 && today !== checkedCookieBeforeCollectToday) {
    await guarded('15:00 Cookie检测', async () => {
      checkedCookieBeforeCollectToday = today;
      await runDailyCookieCheck();
    });
  }

  // 3:00 每日 cookie 有效性巡检（每天一次）
  if (hour === COOKIE_CHECK_HOUR && minute === 0 && today !== checkedCookieToday) {
    await guarded('3:00 Cookie巡检', async () => {
      checkedCookieToday = today;
      await runDailyCookieCheck();
    });
  }

  // 19:30 评论权限检测（每天一次）
  if (hour === CHECK_HOUR && minute === CHECK_MINUTE && today !== checkedCommentPermToday) {
    await guarded('19:30 评论权限检测', async () => {
      checkedCommentPermToday = today;
      await runCommentPermissionCheck();
    });
  }

  // 采集/评论整点触发（当天每个整点仅一次），在整点后 MONITOR_INTERVAL_MIN 分钟窗口内
  if (minute < MONITOR_INTERVAL_MIN && COLLECT_HOURS.includes(hour)) {
    // 先检查是否已 claim，避免任务运行期间重复进入 guarded 打印跳过日志
    const alreadyClaimed = firedHours.get(today)?.has(hour) ?? false;
    if (!alreadyClaimed) {
      await guarded(`${hour}点采集批次`, async () => {
        if (!claimHour(today, hour)) return;
        try {
          if (hour === COMMENT_HOUR) {
            await runCommentPipeline();
          } else {
            await runCollectBatch();
          }
        } catch (e) {
          // 任务失败 → 回滚 claim，允许下次心跳重试
          firedHours.get(today)?.delete(hour);
          throw e;
        }
      });
    }
  }

  // 每 30 分钟监控 tick
  const totalMin = Math.floor(nowDate.getTime() / 60000);
  if (totalMin % MONITOR_INTERVAL_MIN === 0 && totalMin !== lastMonitorMinute) {
    await guarded('监控tick', async () => {
      lastMonitorMinute = totalMin;
      await runMonitorTick();
      // 规范第十三节：可见性检查点完成后增量 QC（轻量聚合）
      try { await runQC(); } catch (e) { schedulerLog.error('[QC] 监控后质检异常', e); }
    });
  }

  // 每 2 小时采集评论数据（仅空闲时段，避开实验运行窗口 14:00-20:00）
  if (totalMin % ANALYZER_INTERVAL_MIN === 0 && totalMin !== lastAnalyzerMinute) {
    if (hour >= EXPERIMENT_WINDOW_START && hour <= EXPERIMENT_WINDOW_END) {
      // 跳过：当前是实验运行时段，优先保证实验 pipeline 的 API 配额和资源
      // 不消费 lastAnalyzerMinute，等下一个空闲 2h 窗口自然触发
    } else {
      await guarded('评论数据采集', async () => {
        lastAnalyzerMinute = totalMin;
        await runAnalyzer();
      });
    }
  }
  
  // 奇数小时空闲时重试采集失败（在整点后 30 分钟窗口内，不与其他任务重叠）
  if (minute >= 30 && minute < 60 && RETRY_HOURS.includes(hour)) {
    await guarded('空闲背压重试', async () => {
      if (!claimHour(today, hour + 100)) return;
      await runRetryCollector();
    });
  }
}

function main(): void {
  console.log(`${'='.repeat(60)}`);
  console.log(`微博正式实验调度器启动  [${ts()}]`);
  console.log(`  实验创建: ${CREATE_HOUR}点 | Cookie预检: ${COOKIE_TEST_HOUR}点 | 采集批次: ${COLLECT_HOURS.join('/')}点 | ${COOKIE_CHECK_HOUR}:00 Cookie巡检 | ${CHECK_HOUR}:${CHECK_MINUTE} 权限检测 | ${COMMENT_HOUR}点批后选帖+评论 | 每${MONITOR_INTERVAL_MIN}min 监控`);
  console.log(`  背压重试: 奇数小时 30-59分 | 模板同步+数据迁移: 启动时自动`);
  console.log(`${'='.repeat(60)}`);

  // 启动任务（顺序执行）
  (async () => {
    // 启动时同步评论模板（先跑，不依赖 posts）
    await guarded('模板同步', async () => {
      const { created, existing } = await ensureTemplates();
      console.log(`[模板同步] 新增 ${created} 条, 已有 ${existing} 条`);
    });

    // 启动时：数据迁移（PREFIX 适配 + post_group 回填）
    await guarded('启动数据迁移', async () => {
      const { postsMigrated, postGroupBackfilled, skipped } = await runStartupMigration();
      if (!skipped) {
        console.log(`[启动迁移] 帖子迁移 ${postsMigrated} 条, post_group 回填 ${postGroupBackfilled} 条`);
      }
    });

    // 启动即跑一次监控（补采可能遗漏的点）
    await guarded('启动监控', runMonitorTick);
  })();

  // t0 可见性检查后台 worker（独立于心跳）：发送期间不阻塞、到期即查，
  // 即使 commenter 正在发送（心跳被占用），t0 检查也能在发送后 1-3 分钟执行
  let busyVisibilityWorker = false;
  setInterval(() => {
    if (busyVisibilityWorker) return;
    busyVisibilityWorker = true;
    runVisibilityT0Worker()
      .catch((e) => schedulerLog.error('[可见性t0] 异常', e))
      .finally(() => { busyVisibilityWorker = false; });
  }, 60_000);

  // 每分钟心跳
  setInterval(() => {
    heartbeat().catch((e) => schedulerLog.error('[调度] 心跳异常', e));
  }, 60_000);
}

async function shutdown(): Promise<void> {
  schedulerLog.log('收到退出信号，关闭连接...');
  try { await closeDb(); } catch { /* ignore */ }
  process.exit(0);
}

/** 未捕获异常的崩溃处理：发邮件告警后退出 */
function handleFatalCrash(label: string, err: Error | unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? (err.stack || '').substring(0, 600) : '';
  console.error(`\n💥 ${label}: ${msg}\n${stack}`);
  try {
    notifySystemAlert('微博', `${label}: ${msg}`, stack || msg);
  } catch { /* 邮件发送失败也继续 */ }
  setTimeout(() => process.exit(1), 3000); // 等 3s 给邮件发送机会
}

process.on('uncaughtException', (err) => handleFatalCrash('未捕获异常(uncaughtException)', err));
process.on('unhandledRejection', (reason) => handleFatalCrash('未处理的Promise拒绝(unhandledRejection)', reason));

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
