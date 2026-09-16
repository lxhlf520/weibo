/**
 * MongoDB 连接与原始数据存储
 * 三个集合：raw_posts / raw_comments / raw_users
 * 存储 API 原始 JSON 响应，不做任何整理过滤
 */
import { MongoClient, Db, Collection, Document } from 'mongodb';
import { MONGO_URL, MONGO_DB } from './config';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getDb(): Promise<Db> {
  if (!db) {
    client = new MongoClient(MONGO_URL);
    await client.connect();
    db = client.db(MONGO_DB);
    console.log(`[DB] 已连接 ${MONGO_URL}${MONGO_DB}`);
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[DB] 连接已关闭');
  }
}

export async function getCollection<T extends Document = Document>(name: string): Promise<Collection<T>> {
  const database = await getDb();
  return database.collection<T>(name);
}

/** 确保索引 */
export async function ensureIndexes(): Promise<void> {
  const postsCol = await getCollection('raw_posts');
  await postsCol.createIndex({ mid: 1 }, { unique: true });
  await postsCol.createIndex({ collected_at: -1 });

  const commentsCol = await getCollection('raw_comments');
  await commentsCol.createIndex({ post_mid: 1 });
  await commentsCol.createIndex({ collected_at: -1 });

  const usersCol = await getCollection('raw_users');
  await usersCol.createIndex({ uid: 1 }, { unique: true });
  await usersCol.createIndex({ collected_at: -1 });

  const stateCol = await getCollection('crawl_state');
  await stateCol.createIndex({ task_key: 1 }, { unique: true });

  console.log('[DB] 索引已就绪');
}

// ─── 原始数据写入 ─────────────────────────────────────────

/** 写入被动采集帖子（upsert by mid） */
export async function savePassivePost(mid: string, rawResponse: any): Promise<boolean> {
  const col = await getCollection('raw_posts_passive');
  const result = await col.updateOne(
    { mid },
    {
      $set: { raw: rawResponse, updated_at: new Date().toISOString() },
      $setOnInsert: { mid, collected_at: new Date().toISOString() },
    },
    { upsert: true },
  );
  return (result.upsertedCount ?? 0) > 0;
}

/** 写入主动采集帖子（upsert by mid） */
export async function saveActivePost(mid: string, rawResponse: any): Promise<boolean> {
  const col = await getCollection('raw_posts_active');
  const result = await col.updateOne(
    { mid },
    {
      $set: { raw: rawResponse, updated_at: new Date().toISOString() },
      $setOnInsert: { mid, collected_at: new Date().toISOString() },
    },
    { upsert: true },
  );
  return (result.upsertedCount ?? 0) > 0;
}

/** 写入被动采集评论 */
export async function savePassiveComments(postMid: string, page: number, rawResponse: any): Promise<void> {
  const col = await getCollection('raw_comments_passive');
  await col.updateOne(
    { post_mid: postMid, page },
    {
      $set: { raw: rawResponse, updated_at: new Date().toISOString() },
      $setOnInsert: { post_mid: postMid, page, collected_at: new Date().toISOString() },
    },
    { upsert: true },
  );
}

/** 写入主动采集评论 */
export async function saveActiveComments(postMid: string, page: number, rawResponse: any): Promise<void> {
  const col = await getCollection('raw_comments_active');
  await col.updateOne(
    { post_mid: postMid, page },
    {
      $set: { raw: rawResponse, updated_at: new Date().toISOString() },
      $setOnInsert: { post_mid: postMid, page, collected_at: new Date().toISOString() },
    },
    { upsert: true },
  );
}

/** 写入用户原始数据（upsert by uid） */
export async function saveRawUser(uid: string, rawResponse: any): Promise<boolean> {
  const col = await getCollection('raw_users');
  const result = await col.updateOne(
    { uid },
    {
      $set: { raw: rawResponse, updated_at: new Date().toISOString() },
      $setOnInsert: { uid, collected_at: new Date().toISOString() },
    },
    { upsert: true },
  );
  return (result.upsertedCount ?? 0) > 0;
}

// ─── 查询 ─────────────────────────────────────────────────

/** 帖子是否已采集（检查所有帖子集合） */
export async function isPostCollected(mid: string): Promise<boolean> {
  const [inPassive, inActive, inOld] = await Promise.all([
    (await getCollection('raw_posts_passive')).countDocuments({ mid }),
    (await getCollection('raw_posts_active')).countDocuments({ mid }),
    (await getCollection('raw_posts')).countDocuments({ mid }),
  ]);
  return (inPassive + inActive + inOld) > 0;
}

/** 各集合数量统计（主动+被动） */
export async function getCounts(): Promise<{ posts: number; commentPages: number; users: number }> {
  const [passivePosts, activePosts, passiveComments, activeComments, oldPosts, oldComments, users] = await Promise.all([
    (await getCollection('raw_posts_passive')).countDocuments(),
    (await getCollection('raw_posts_active')).countDocuments(),
    (await getCollection('raw_comments_passive')).countDocuments(),
    (await getCollection('raw_comments_active')).countDocuments(),
    (await getCollection('raw_posts')).countDocuments(),
    (await getCollection('raw_comments')).countDocuments(),
    (await getCollection('raw_users')).countDocuments(),
  ]);
  return {
    posts: passivePosts + activePosts + oldPosts,
    commentPages: passiveComments + activeComments + oldComments,
    users,
  };
}

/** 分别获取主动/被动数量 */
export async function getSeparateCounts(): Promise<{ passivePosts: number; activePosts: number; oldPosts: number }> {
  const [passivePosts, activePosts, oldPosts] = await Promise.all([
    (await getCollection('raw_posts_passive')).countDocuments(),
    (await getCollection('raw_posts_active')).countDocuments(),
    (await getCollection('raw_posts')).countDocuments(),
  ]);
  return { passivePosts, activePosts, oldPosts };
}

// ─── 爬取进度 ─────────────────────────────────────────────

export async function saveCrawlState(taskKey: string, state: Record<string, any>): Promise<void> {
  const col = await getCollection('crawl_state');
  await col.updateOne(
    { task_key: taskKey },
    { $set: { ...state, updated_at: new Date().toISOString() } },
    { upsert: true },
  );
}

export async function getCrawlState(taskKey: string) {
  const col = await getCollection('crawl_state');
  return col.findOne({ task_key: taskKey });
}
