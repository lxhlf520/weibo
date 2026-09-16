/** 清除全部 unified_ 断点（配合已存帖子跳过+进程内去重，重新全量搜索入队） */
import { MongoClient } from 'mongodb';

async function main() {
  const client = new MongoClient('mongodb://localhost:27017');
  await client.connect();
  const col = client.db('robert_comments').collection('crawl_state');
  const res = await col.deleteMany({ task_key: /^unified_/ });
  console.log(`清除断点: ${res.deletedCount} 条`);
  await client.close();
}

main().catch(console.error);
