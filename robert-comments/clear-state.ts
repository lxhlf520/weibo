/** 清除所有 unified_ 断点记录，确保修复后的判断逻辑对全部日期重新生效 */
import { MongoClient } from 'mongodb';

async function main() {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  const col = client.db('robert_comments').collection('crawl_state');
  const before = await col.countDocuments({ task_key: /^unified_/ });
  const res = await col.deleteMany({ task_key: /^unified_/ });
  console.log(`清除断点: ${res.deletedCount} 条 (原有 ${before} 条)`);
  await client.close();
}

main().catch(console.error);
