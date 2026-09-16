/**
 * CLI: 每日增量采集
 *
 * 用法:
 *   npx tsx collect-daily.ts                       # 采集昨天
 *   npx tsx collect-daily.ts --date 2026-08-15     # 指定日期
 */
import { COOKIES, ts } from './src/config';
import { collectPassive } from './src/collector';
import { closeDb, getCounts } from './src/db';

async function main() {
  console.log(`\n[每日采集] 开始  ${ts()}`);

  const args = process.argv.slice(2);
  const di = args.indexOf('--date');
  let date: string;

  if (di >= 0 && args[di + 1]) {
    date = args[di + 1];
  } else {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    date = yesterday.toISOString().split('T')[0];
  }

  console.log(`日期: ${date}`);

  try {
    await collectPassive(date, date);
    const { posts, commentPages, users } = await getCounts();
    console.log(`\n[完成] 帖子: ${posts}  评论页: ${commentPages}  用户: ${users}`);
  } catch (err) {
    console.error('[异常]:', err);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main();
