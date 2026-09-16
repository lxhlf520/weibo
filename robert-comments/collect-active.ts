/**
 * 主动评论采集 CLI
 * 策略：高命中关键词 + 热搜 → 不限日期搜索 → 高互动帖子筛选 → 并行检查罗伯特
 *
 * 用法:
 *   npx tsx collect-active.ts          # 目标300条
 *   npx tsx collect-active.ts 500      # 目标500条
 */
import { collectActive } from './src/collector';
import { closeDb } from './src/db';
import { ts } from './src/config';

async function main() {
  const args = process.argv.slice(2);
  const targetCount = Number(args[0]) || 300;

  console.log(`\n[主动采集] ${ts()}`);
  console.log(`目标: ${targetCount} 条`);

  try {
    const stats = await collectActive(targetCount);
    console.log(`\n[完成] 检查 ${stats.postsChecked} 帖子，发现罗伯特 ${stats.robertFound} 条`);
  } finally {
    await closeDb();
  }
}

main().catch(async (err) => {
  console.error('[异常]:', err);
  await closeDb();
  process.exit(1);
});
