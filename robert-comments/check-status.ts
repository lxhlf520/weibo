/**
 * CLI: 查看采集进度
 *
 * 用法:
 *   npx tsx check-status.ts
 */
import { closeDb } from './src/db';
import { printStatus } from './src/status';

async function main() {
  try {
    await printStatus();
  } catch (err) {
    console.error('[异常]:', err);
    process.exit(1);
  } finally {
    await closeDb();
  }
}

main();
