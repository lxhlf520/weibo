/**
 * 数据采集背压重试
 * ============================================================================
 * 读取 collection_errors 中失败的帖子，用不同账号逐一重试采集。
 * 成功则清除错误记录，失败则递增 retry_count。
 *
 * 调度器在 analyzer 间隔的空闲时段（奇数小时整点）调用此 job。
 *
 * 直跑调试：npx tsx src/jobs/retry-collector.ts [experimentId]
 */

import { runAnalyzer } from './analyzer';
import { ts } from './shared';

export async function runRetryCollector(expIdArg?: string): Promise<void> {
  console.log(`\n[背压重试] 开始  [${ts()}]`);
  console.log(`  扫描 collection_errors 中待重试的帖子...\n`);

  await runAnalyzer(expIdArg, true);

  console.log(`[背压重试] 完成  [${ts()}]`);
}

// ── 直跑入口 ──
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('jobs/retry-collector.ts')) {
  runRetryCollector(process.argv[2])
    .then(async () => {
      const { closeDb } = await import('../lib/db');
      await closeDb();
      process.exit(0);
    })
    .catch((e) => {
      console.error('重试异常:', e);
      process.exit(1);
    });
}
