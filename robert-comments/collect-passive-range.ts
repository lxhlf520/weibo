/**
 * CLI: 被动评论采集（日期范围）
 *
 * 用法:
 *   npx tsx collect-passive-range.ts 2026-08-01 2026-08-14 4666
 */
import { COOKIES, ts } from './src/config';
import { collectPassive } from './src/collector';
import { closeDb, getCounts } from './src/db';

async function main() {
  const args = process.argv.slice(2);
  const startDate = args[0];
  const endDate = args[1] || startDate;

  if (!startDate) {
    console.log('用法: npx tsx collect-passive-range.ts <开始日期> [结束日期]');
    console.log('示例: npx tsx collect-passive-range.ts 2026-08-01 2026-08-14');
    process.exit(1);
  }

  console.log(`\n[被动采集] ${ts()}`);
  console.log(`日期范围: ${startDate} ~ ${endDate}`);

  if (!COOKIES.length) {
    console.error('[错误] 未配置 WEIBO_COOKIES');
    process.exit(1);
  }
  console.log(`Cookie: ${COOKIES.length} 个`);

  try {
    // 循环日期
    const start = new Date(startDate);
    const end = new Date(endDate);
    const cursor = new Date(start);

    while (cursor <= end) {
      const dateStr = cursor.toISOString().split('T')[0];
      console.log(`\n>>> 采集日期: ${dateStr}`);
      await collectPassive(dateStr, dateStr);
      cursor.setDate(cursor.getDate() + 1);
    }

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
