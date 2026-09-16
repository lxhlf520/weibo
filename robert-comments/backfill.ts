/**
 * CLI: 回溯采集
 *
 * 用法:
 *   npx tsx backfill.ts                          # 默认 8.1-8.8
 *   npx tsx backfill.ts --start 2026-08-01 --end 2026-08-08
 */
import { COOKIES, ts } from './src/config';
import { collectPassive } from './src/collector';
import { closeDb, getCounts } from './src/db';

async function main() {
  console.log(`\n[回溯采集] 开始  ${ts()}`);
  console.log(`Cookie: ${COOKIES.length} 个`);

  const args = process.argv.slice(2);
  let startDate = '2026-08-01';
  let endDate = '2026-08-08';

  const si = args.indexOf('--start');
  const ei = args.indexOf('--end');
  if (si >= 0 && args[si + 1]) startDate = args[si + 1];
  if (ei >= 0 && args[ei + 1]) endDate = args[ei + 1];

  console.log(`范围: ${startDate} ~ ${endDate}\n`);

  try {
    await collectPassive(startDate, endDate);
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
