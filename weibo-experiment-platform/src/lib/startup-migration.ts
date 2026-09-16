/**
 * 启动时数据迁移：解决 PREFIX 不匹配 + post_group 回填
 * ============================================================================
 * 背景：
 *   1. db.ts 的 PREFIX 从空字符串改为 'weibo_'/'twitter_' 后，
 *      旧数据在 posts（无前缀），新代码读写 weibo_posts（有前缀），导致数据不可见。
 *   2. post_group 字段可能在早期插入时缺失，需从 intervention_logs 回填。
 *
 * 本迁移在调度器启动时运行，幂等（多次运行无害）。
 */
import { getDb } from './db';
import type { Db } from 'mongodb';

interface MigrationResult {
  postsMigrated: number;
  postGroupBackfilled: number;
  skipped: boolean;
}

/**
 * 执行启动迁移：
 *   1) 检查无前缀的 posts 是否存在
 *   2) 如果存在且有数据，拷贝到有前缀的 posts（若目标为空）
 *   3) 对有前缀 posts 中缺失 post_group 的记录做回填
 */
export async function runStartupMigration(): Promise<MigrationResult> {
  const db = await getDb();
  const result: MigrationResult = { postsMigrated: 0, postGroupBackfilled: 0, skipped: false };

  // ─ 发现旧 posts（无前缀）与新 posts（有前缀） ─
  const colls = await db.listCollections().toArray();
  const names = new Set(colls.map(c => c.name));

  const oldPosts = 'posts';
  const newPosts = names.has('weibo_posts') ? 'weibo_posts' : names.has('twitter_posts') ? 'twitter_posts' : null;

  if (!newPosts) {
    // 没有找到任何带前缀的 posts 集合，可能是纯 pg 迁移或前缀未设置
    // 检查旧 posts 是否存在
    if (!names.has(oldPosts)) {
      console.log('[启动迁移] 未发现任何 posts 集合，跳过');
      result.skipped = true;
      return result;
    }
    // 只有旧 posts → 无需迁移（但做回填）
    console.log('[启动迁移] 仅发现 posts（无前缀），跳过集合迁移');
    result.postGroupBackfilled = await backfillPostGroup(db, oldPosts);
    return result;
  }

  // ─ 1) 拷贝旧 posts → 新 posts（仅当新 posts 为空时） ─
  const oldColl = db.collection(oldPosts);
  const newColl = db.collection(newPosts);

  const oldCount = await oldColl.countDocuments();
  const newCount = await newColl.countDocuments();

  if (oldCount > 0 && newCount === 0) {
    console.log(`[启动迁移] 发现旧 posts (${oldCount} 条) → 迁移到 ${newPosts}`);
    const docs = await oldColl.find({}).toArray();
    if (docs.length > 0) {
      await newColl.insertMany(docs);
      result.postsMigrated = docs.length;
      console.log(`[启动迁移] 已迁移 ${result.postsMigrated} 条`);
    }
  } else if (oldCount > 0 && newCount > 0) {
    console.log(`[启动迁移] 新旧 posts 均有数据: old=${oldCount}, new=${newCount}`);
    // 合并：只迁移新 posts 中不存在的
    const newPostIds = new Set<string>();
    const newCursor = newColl.find({}, { projection: { post_id: 1 } });
    while (await newCursor.hasNext()) {
      const doc = await newCursor.next();
      if (doc?.post_id) newPostIds.add(String(doc.post_id));
    }

    const missing = [];
    const oldCursor = oldColl.find({});
    while (await oldCursor.hasNext()) {
      const doc = await oldCursor.next();
      if (doc && doc.post_id && !newPostIds.has(String(doc.post_id))) {
        missing.push(doc);
      }
    }
    if (missing.length > 0) {
      await newColl.insertMany(missing);
      result.postsMigrated = missing.length;
      console.log(`[启动迁移] 补充迁移 ${missing.length} 条（按 post_id 去重）`);
    }
  } else {
    console.log(`[启动迁移] 新旧 posts 无需迁移: old=${oldCount}, new=${newCount}`);
  }

  // ─ 2) 对新 posts 做 post_group 回填 ─
  result.postGroupBackfilled = await backfillPostGroup(db, newPosts);

  return result;
}

/**
 * 从 intervention_logs 回填 posts 中缺失的 post_group
 */
async function backfillPostGroup(db: Db, postsCollName: string): Promise<number> {
  const postsColl = db.collection(postsCollName);

  const missingCount = await postsColl.countDocuments({
    $or: [
      { post_group: { $exists: false } },
      { post_group: '' },
      { post_group: null, $or: [{ is_spare: { $exists: false } }, { is_spare: false }] },
    ]
  });

  if (missingCount === 0) {
    console.log('[post_group回填] 无需回填');
    return 0;
  }

  console.log(`[post_group回填] 发现 ${missingCount} 条需回填`);

  // 从 intervention_logs 读取分组映射（处理有/无前缀两种情况）
  let logsCollName = 'weibo_intervention_logs';
  const colls = await db.listCollections().toArray();
  const collNames = colls.map(c => c.name);
  if (!collNames.includes(logsCollName)) {
    logsCollName = collNames.includes('intervention_logs') ? 'intervention_logs' : logsCollName;
  }

  const logsColl = db.collection(logsCollName);
  const allLogs = await logsColl.find({}).toArray();

  const groupMap = new Map<string, string>();
  for (const log of allLogs) {
    const pid = String(log.post_id || '');
    const group = log.post_group;
    if (pid && group && group !== 'control') {
      groupMap.set(pid, group);
    }
  }

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

    if (groupMap.has(postId)) {
      newGroup = groupMap.get(postId)!;
    } else if (groupMap.has(String(post.post_id || ''))) {
      newGroup = groupMap.get(String(post.post_id))!;
    } else if (post.is_spare === true || post.is_spare === 'true') {
      newGroup = null;
      setNull++;
    } else {
      newGroup = 'control';
      setControl++;
    }

    if (newGroup !== undefined) {
      await postsColl.updateOne(
        { _id: post._id },
        { $set: { post_group: newGroup } }
      );
      updated++;
    }
  }

  console.log(`[post_group回填] 完成: ${updated} 条 (control:${setControl}, from_log:${updated - setControl - setNull}, null:${setNull})`);
  return updated;
}
