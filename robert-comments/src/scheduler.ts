/**
 * 定时调度器 - 每天凌晨 2:00 自动采集
 *
 * 用法:
 *   npx tsx src/scheduler.ts
 */
import cron from 'node-cron';
import { COOKIES, ts } from './config';
import { collectPassive } from './collector';
import { closeDb, ensureIndexes, getCounts } from './db';
import { printStatus } from './status';

async function runDailyTask(): Promise<void> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const date = yesterday.toISOString().split('T')[0];

  console.log(`\n[调度器] 触发采集  ${ts()}  日期: ${date}`);

  try {
    await ensureIndexes();
    await collectPassive(date, date);
    await printStatus();
  } catch (err) {
    console.error('[调度器] 采集失败:', err);
  }
}

async function main() {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`  罗伯特评论采集 - 定时调度器`);
  console.log(`  启动: ${ts()}  Cookie: ${COOKIES.length} 个`);
  console.log(`  定时: 每天 02:00`);
  console.log(`${'='.repeat(50)}\n`);

  try {
    await ensureIndexes();
    await printStatus();
  } catch (err) {
    console.error('[调度器] 初始化失败:', err);
  }

  cron.schedule('0 2 * * *', async () => {
    await runDailyTask();
  }, { timezone: 'Asia/Shanghai' });

  console.log('[调度器] 等待执行...\n');

  process.on('SIGINT', async () => {
    console.log('\n[调度器] SIGINT，关闭...');
    await closeDb();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[调度器] SIGTERM，关闭...');
    await closeDb();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[调度器] 启动失败:', err);
  process.exit(1);
});
