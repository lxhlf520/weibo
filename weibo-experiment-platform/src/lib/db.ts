import { MongoClient, Db, Collection, Document, Filter, OptionalUnlessRequiredId, WithId, ObjectId, Sort } from 'mongodb';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// 加载 .env.local（Next.js 自动加载，但独立 tsx 脚本需要手动）
(function loadEnvLocal() {
  try {
    const content = readFileSync(resolve(process.cwd(), '.env.local'), 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.substring(0, eq).trim();
        const val = trimmed.substring(eq + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  } catch { /* .env.local 不存在则跳过 */ }
})();

let client: MongoClient | null = null;
let _db: Db | null = null;

/** 集合名前缀，区分微博与 Twitter 平台 */
const PREFIX = 'weibo_';
function cn(name: string): string { return PREFIX + name; }
export { cn };

function getUri(): string {
  return process.env.MONGO_URI || 'mongodb://root:IS%23514_ca@localhost:27017/';
}

export async function getDb(): Promise<Db> {
  if (_db) return _db;
  client = new MongoClient(getUri(), {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await client.connect();
  _db = client.db(process.env.MONGO_DB || 'weibo_experiment');
  return _db;
}

/** 关闭连接（测试/进程退出用） */
export async function closeDb(): Promise<void> {
  if (client) { await client.close(); client = null; _db = null; }
}

// ============ 采集库（weibo_supplement）独立连接 ============
// 采集库为外部采集工程的库：集合名无 weibo_ 前缀，直接按原名访问
let supClient: MongoClient | null = null;
let _supDb: Db | null = null;

export async function getSupplementDb(): Promise<Db> {
  if (_supDb) return _supDb;
  supClient = new MongoClient(getUri(), {
    maxPoolSize: 10,
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });
  await supClient.connect();
  _supDb = supClient.db(process.env.MONGO_SUPPLEMENT_DB || 'weibo_supplement');
  return _supDb;
}

/** 字符串 ID → ObjectId，非法格式返回原值 */
export function toObjectId(id: string | number): ObjectId | string | number {
  if (typeof id === 'number') return id;
  if (ObjectId.isValid(id)) return new ObjectId(id);
  return id;
}

/** 过滤器中所有的 id 字段自动转为 ObjectId */
function normalizeFilter(filter: Filter<Document>): Filter<Document> {
  if (!filter || typeof filter !== 'object') return filter;
  const result: Record<string, unknown> = { ...filter as Record<string, unknown> };
  if ('id' in result && result.id !== undefined) {
    result._id = toObjectId(result.id as string);
    delete result.id;
  }
  return result as Filter<Document>;
}

/** 文档 _id → id 字符串，其余字段原样 */
function formatDoc<T>(doc: WithId<Document> | null): T | null {
  if (!doc) return null;
  const { _id, ...rest } = doc;
  return { id: _id.toString(), ...rest } as unknown as T;
}

function formatDocs<T>(docs: WithId<Document>[]): T[] {
  return docs.map(d => {
    const { _id, ...rest } = d;
    return { id: _id.toString(), ...rest } as unknown as T;
  });
}

// ============ 公开 API（替换 pg 版同名函数） ============

/**
 * 查询多条文档
 * @param collection 集合名称
 * @param filter MongoDB 过滤条件
 * @param opts.sort 排序，如 { created_at: -1 }
 * @param opts.limit 限制条数
 * @param opts.projection 字段投影，如 { mid: 1, author_uid: 1 }
 */
export async function query<T = Record<string, unknown>>(
  collection: string,
  filter: Filter<Document> = {},
  opts?: { sort?: Sort; limit?: number; projection?: Document },
): Promise<{ rows: T[]; rowCount: number }> {
  const coll = (await getDb()).collection(cn(collection));
  const normalized = normalizeFilter(filter);
  let cursor = coll.find(normalized);
  if (opts?.sort) cursor = cursor.sort(opts.sort);
  if (opts?.limit) cursor = cursor.limit(opts.limit);
  if (opts?.projection) cursor = cursor.project(opts.projection);
  const docs = await cursor.toArray();
  return { rows: formatDocs<T>(docs), rowCount: docs.length };
}

/**
 * 查询单条文档
 * @param collection 集合名称
 * @param filter MongoDB 过滤条件
 */
export async function maybeOne<T = Record<string, unknown>>(
  collection: string,
  filter: Filter<Document> = {},
): Promise<T | null> {
  const coll = (await getDb()).collection(cn(collection));
  const doc = await coll.findOne(normalizeFilter(filter));
  return formatDoc<T>(doc);
}

/**
 * 插入一条文档并返回完整文档（含 _id → id）
 * @param collection 集合名称
 * @param data 文档数据
 */
export async function insert<T = Record<string, unknown>>(
  collection: string,
  data: Record<string, unknown>,
): Promise<T | null> {
  const coll = (await getDb()).collection(cn(collection));
  const result = await coll.insertOne(data as OptionalUnlessRequiredId<Document>);
  const doc = await coll.findOne({ _id: result.insertedId });
  return formatDoc<T>(doc);
}

/**
 * 更新一条文档并返回更新后的文档
 * @param collection 集合名称
 * @param filter 过滤条件
 * @param update 更新的字段（会用 $set）
 */
export async function updateOne<T = Record<string, unknown>>(
  collection: string,
  filter: Filter<Document>,
  update: Record<string, unknown>,
): Promise<T | null> {
  const coll = (await getDb()).collection(cn(collection));
  const normalized = normalizeFilter(filter);
  const result = await coll.findOneAndUpdate(
    normalized,
    { $set: update },
    { returnDocument: 'after' },
  );
  return formatDoc<T>(result);
}

/**
 * 批量更新多条文档
 * @param collection 集合名称
 * @param filter 过滤条件
 * @param update 更新的字段（会用 $set）
 */
export async function updateMany(
  collection: string,
  filter: Filter<Document>,
  update: Record<string, unknown>,
): Promise<{ rowCount: number }> {
  const coll = (await getDb()).collection(cn(collection));
  const normalized = normalizeFilter(filter);
  const result = await coll.updateMany(normalized, { $set: update });
  return { rowCount: result.modifiedCount };
}

/**
 * 删除一条文档
 */
export async function deleteOne(
  collection: string,
  filter: Filter<Document>,
): Promise<{ deleted: boolean }> {
  const coll = (await getDb()).collection(cn(collection));
  const result = await coll.deleteOne(normalizeFilter(filter));
  return { deleted: result.deletedCount > 0 };
}

/**
 * 批量删除多条文档
 */
export async function deleteMany(
  collection: string,
  filter: Filter<Document>,
): Promise<{ rowCount: number }> {
  const coll = (await getDb()).collection(cn(collection));
  const result = await coll.deleteMany(normalizeFilter(filter));
  return { rowCount: result.deletedCount };
}

/**
 * 计数
 */
export async function count(
  collection: string,
  filter: Filter<Document> = {},
): Promise<number> {
  const coll = (await getDb()).collection(cn(collection));
  return coll.countDocuments(normalizeFilter(filter));
}

/**
 * 原子递增字段（如 daily_comment_count + 1）
 * 用法: inc('accounts', { id: 'xxx' }, { daily_comment_count: 1 })
 */
export async function inc(
  collection: string,
  filter: Filter<Document>,
  increments: Record<string, number>,
): Promise<void> {
  const coll = (await getDb()).collection(cn(collection));
  await coll.updateOne(normalizeFilter(filter), { $inc: increments });
}

/**
 * 存在则更新，不存在则插入（upsert）
 * @param collection 集合名称
 * @param filter 唯一键过滤条件
 * @param data 要 upsert 的数据
 */
export async function upsert<T = Record<string, unknown>>(
  collection: string,
  filter: Filter<Document>,
  data: Record<string, unknown>,
): Promise<T | null> {
  const coll = (await getDb()).collection(cn(collection));
  const setOnInsert: Record<string, unknown> = {};
  if (!('created_at' in data)) {
    setOnInsert.created_at = new Date().toISOString();
  }
  const result = await coll.findOneAndUpdate(
    normalizeFilter(filter),
    { $set: data, $setOnInsert: setOnInsert },
    { upsert: true, returnDocument: 'after' },
  );
  return formatDoc<T>(result);
}

/**
 * 确保集合存在唯一索引（幂等，重复调用无害）。
 * 用于 experiment_author_registry 等需要数据库级并发去重的集合
 * （代码先查再写无法防止并发竞态，唯一约束冲突 code=11000 由调用方捕获处理）。
 * @param collection 集合名称
 * @param keys 唯一索引键，如 { platform: 1, post_author_id: 1 }
 */
export async function ensureUniqueIndex(
  collection: string,
  keys: Record<string, 1 | -1>,
): Promise<void> {
  const coll = (await getDb()).collection(cn(collection));
  await coll.createIndex(keys, { unique: true });
}
