/**
 * 回填 posts 表的 post_group 字段
 * ============================================================================
 * 从 intervention_logs 中读取每篇帖子的分组信息，回写到 posts.post_group。
 * 
 * 运行：
 *   # 微博
 *   npx tsx scripts/backfill-post-group.ts weibo
 *   # Twitter  
 *   npx tsx scripts/backfill-post-group.ts twitter
 */
import { MongoClient } from 'mongodb';

// ============ 配置 ============
const MONGO_URI = process.env.MONGO_URI || 'mongodb://root:IS%23514_ca@localhost:27017/';

async function backfill(dbName: string) {
  const client = new MongoClient(MONGO_URI, {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await client.connect();
  const db = client.db(dbName);
  console.log(`\n连接数据库: ${dbName}`);

  // 查找 posts 集合（可能是 posts 或带平台前缀的如 weibo_posts）
  const colls = await db.listCollections().toArray();
  const postsCollName = colls.find(c => c.name === 'posts' || c.name.endsWith('_posts'))?.name;
  if (!postsCollName) {
    console.log('未找到 posts 集合');
    await client.close();
    return;
  }
  console.log(`posts 集合: ${postsCollName}`);

  const postsColl = db.collection(postsCollName);
  const totalPosts = await postsColl.countDocuments();
  console.log(`帖文总数: ${totalPosts}`);

  // 统计 post_group 缺失情况
  const missing = await postsColl.countDocuments({ 
    $or: [
      { post_group: { $exists: false } },
      { post_group: '' },
    ]
  });
  
  // 也检查 post_group 为 null 但 is_spare 不为 true 的（可能是意外 null）
  const nullButNotSpare = await postsColl.countDocuments({
    post_group: null,
    $or: [
      { is_spare: { $exists: false } },
      { is_spare: false },
    ]
  });

  console.log(`post_group 缺失: ${missing}`);
  console.log(`post_group=null 但非备选: ${nullButNotSpare}`);

  if (missing === 0 && nullButNotSpare === 0) {
    console.log('\n✅ 无需回填，所有 post_group 已正确设置');
    await client.close();
    return;
  }

  // ── 从 intervention_logs 读取分组映射 ──
  const logsColl = db.collection('intervention_logs');
  const allLogs = await logsColl.find({}).toArray();
  console.log(`\nintervention_logs 共 ${allLogs.length} 条`);

  // 构建 post_id → post_group 映射
  const groupMap = new Map<string, string>();
  for (const log of allLogs) {
    const pid = String(log.post_id || '');
    const group = log.post_group;
    if (pid && group && group !== 'control') {
      // 只取非 control 组（control 组可能在 logs 中不存在）
      groupMap.set(pid, group);
    }
  }
  console.log(`从 intervention_logs 中提取到 ${groupMap.size} 条映射`);

  // ── 逐条回填 ──
  let updated = 0;
  let setControl = 0;
  let setNull = 0;

  const cursor = postsColl.find({
    $or: [
      { post_group: { $exists: false } },
      { post_group: '' },
      { post_group: null, $or: [{ is_spare: { $exists: false } }, { is_spare: false }] },
    ]
  });

  while (await cursor.hasNext()) {
    const post = await cursor.next();
    if (!post) continue;

    const postId = String(post._id || '');
    let newGroup: string | null = null;

    // 1. 先查 intervention_logs 映射
    if (groupMap.has(postId)) {
      newGroup = groupMap.get(postId)!;
    } else if (groupMap.has(String(post.post_id || ''))) {
      newGroup = groupMap.get(String(post.post_id))!;
    }
    // 2. 如果 is_spare，设为 null
    else if (post.is_spare === true || post.is_spare === 'true') {
      newGroup = null;
      setNull++;
    }
    // 3. 否则默认为 control（对照组不会在 intervention_logs 中出现）
    else {
      newGroup = 'control';
      setControl++;
    }

    if (newGroup !== undefined) {
      await postsColl.updateOne(
        { _id: post._id },
        { $set: { post_group: newGroup } }
      );
      updated++;
      
      if (updated % 20 === 0) {
        console.log(`  回填进度: ${updated} 条 (control:${setControl}, from_log:${updated - setControl - setNull}, null:${setNull})`);
      }
    }
  }

  console.log(`\n✅ 回填完成:`);
  console.log(`   总计更新: ${updated} 条`);
  console.log(`   - 从 intervention_logs: ${updated - setControl - setNull} 条`);
  console.log(`   - 设为 control: ${setControl} 条`);
  console.log(`   - 设为 null (备选): ${setNull} 条`);

  // 验证
  const remaining = await postsColl.countDocuments({ 
    $or: [
      { post_group: { $exists: false } },
      { post_group: '' },
    ]
  });
  console.log(`   残留缺失: ${remaining} 条`);
  
  // 最终统计
  const byGroup = await postsColl.aggregate([
    { $group: { _id: '$post_group', count: { $sum: 1 } } }
  ]).toArray();
  console.log('\n回填后 post_group 分布:');
  byGroup.forEach(g => console.log(`   ${g._id}: ${g.count}`));

  await client.close();
}

// ── 入口 ──
const platform = process.argv[2];
if (!platform || !['weibo', 'twitter'].includes(platform)) {
  console.log('用法: npx tsx scripts/backfill-post-group.ts [weibo|twitter]');
  process.exit(1);
}

const dbName = platform === 'weibo' 
  ? (process.env.MONGO_DB || 'weibo_experiment')
  : (process.env.MONGO_DB || 'twitter_experiment');

backfill(dbName).catch(e => {
  console.error('回填异常:', e);
  process.exit(1);
});
