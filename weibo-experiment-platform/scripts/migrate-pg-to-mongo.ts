/**
 * PostgreSQL → MongoDB 数据迁移脚本
 * 用法: npx tsx scripts/migrate-pg-to-mongo.ts
 */
import { Pool } from 'pg';
import { getDb, closeDb } from '../src/lib/db';

// 连接配置从环境变量读取（见 .env.example；本地运行前设置 PG_PASSWORD 等）
const pg = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: Number(process.env.PG_PORT || 5432),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
  database: process.env.PG_DB || 'weibo_experiment',
});

async function migrateTable(pgTable: string, mongoColl: string, idMap?: Map<number, string>) {
  const { rows } = await pg.query(`SELECT * FROM ${pgTable}`);
  if (rows.length === 0) { console.log(`  ${pgTable}: 空表，跳过`); return; }

  const db = await getDb();
  const coll = db.collection(mongoColl);

  const docs = rows.map((row: any) => {
    const { id, ...rest } = row;
    const doc: any = { ...rest };

    // 转换 created_at / updated_at 等字段为 ISO 字符串
    for (const key of ['created_at', 'updated_at', 'last_used_at', 'screened_at', 'published_at',
      'sent_at', 'collected_at', 'calculated_at', 'comment_time']) {
      if (doc[key] instanceof Date) doc[key] = doc[key].toISOString();
    }

    return doc;
  });

  const result = await coll.insertMany(docs);
  console.log(`  ${pgTable} → ${mongoColl}: ${result.insertedCount} 条`);

  // 建立旧ID映射
  if (idMap) {
    for (let i = 0; i < rows.length; i++) {
      idMap.set(rows[i].id as number, result.insertedIds[i].toString());
    }
  }
}

async function main() {
  console.log('开始迁移 PostgreSQL → MongoDB ...\n');

  const idMap = new Map<number, string>();

  // 用户与模板（无外键依赖）
  await migrateTable('experiment_users', 'experiment_users');
  await migrateTable('comment_templates', 'comment_templates');

  // 账号（无外键依赖）
  await migrateTable('weibo_accounts', 'weibo_accounts');

  // 实验（被 posts 依赖，建立ID映射）
  const { rows: exps } = await pg.query('SELECT * FROM experiment_runs');
  if (exps.length > 0) {
    const db = await getDb();
    const docs = [];
    for (const row of exps) {
      const { id, ...rest } = row;
      const doc: any = { ...rest };
      for (const key of ['created_at', 'updated_at']) {
        if (doc[key] instanceof Date) doc[key] = doc[key].toISOString();
      }
      docs.push(doc);
    }
    const result = await db.collection('experiment_runs').insertMany(docs);
    for (let i = 0; i < exps.length; i++) {
      idMap.set(exps[i].id as number, result.insertedIds[i].toString());
    }
    console.log(`  experiment_runs: ${result.insertedCount} 条`);
  }

  // 帖子（依赖 experiment_runs，用 idMap 替换 experiment_id）
  const { rows: posts } = await pg.query('SELECT * FROM posts');
  if (posts.length > 0) {
    const db = await getDb();
    const postIdMap = new Map<number, string>();
    const docs = [];
    for (const row of posts) {
      const { id, ...rest } = row;
      const doc: any = { ...rest };
      // 替换 experiment_id
      if (doc.experiment_id && idMap.has(doc.experiment_id)) {
        doc.experiment_id = idMap.get(doc.experiment_id);
      }
      for (const key of ['created_at', 'screened_at', 'published_at']) {
        if (doc[key] instanceof Date) doc[key] = doc[key].toISOString();
      }
      docs.push(doc);
    }
    const result = await db.collection('posts').insertMany(docs);
    for (let i = 0; i < posts.length; i++) {
      postIdMap.set(posts[i].id as number, result.insertedIds[i].toString());
    }
    console.log(`  posts: ${result.insertedCount} 条`);

    // 帖子快照（依赖 posts）
    const { rows: snapshots } = await pg.query('SELECT * FROM post_snapshots');
    if (snapshots.length > 0) {
      const snapDocs = snapshots.map((row: any) => {
        const { id, ...rest } = row;
        const doc: any = { ...rest };
        if (doc.post_id && postIdMap.has(doc.post_id)) {
          doc.post_id = postIdMap.get(doc.post_id);
        }
        if (doc.collected_at instanceof Date) doc.collected_at = doc.collected_at.toISOString();
        return doc;
      });
      const snapResult = await db.collection('post_snapshots').insertMany(snapDocs);
      console.log(`  post_snapshots: ${snapResult.insertedCount} 条`);
    }

    // 评论快照
    const { rows: comments } = await pg.query('SELECT * FROM comment_snapshots');
    if (comments.length > 0) {
      const commentDocs = comments.map((row: any) => {
        const { id, ...rest } = row;
        const doc: any = { ...rest };
        if (doc.post_id && postIdMap.has(doc.post_id)) {
          doc.post_id = postIdMap.get(doc.post_id);
        }
        if (doc.comment_time instanceof Date) doc.comment_time = doc.comment_time.toISOString();
        return doc;
      });
      const commentResult = await db.collection('comment_snapshots').insertMany(commentDocs);
      console.log(`  comment_snapshots: ${commentResult.insertedCount} 条`);
    }

    // 干预日志（依赖 posts）
    const { rows: logs } = await pg.query('SELECT * FROM intervention_logs');
    if (logs.length > 0) {
      const logDocs = logs.map((row: any) => {
        const { id, ...rest } = row;
        const doc: any = { ...rest };
        if (doc.experiment_id && idMap.has(doc.experiment_id)) {
          doc.experiment_id = idMap.get(doc.experiment_id);
        }
        if (doc.post_id && postIdMap.has(doc.post_id)) {
          doc.post_id = postIdMap.get(doc.post_id);
        }
        if (doc.sent_at instanceof Date) doc.sent_at = doc.sent_at.toISOString();
        return doc;
      });
      const logResult = await db.collection('intervention_logs').insertMany(logDocs);
      console.log(`  intervention_logs: ${logResult.insertedCount} 条`);
    }

    // 结果分析（依赖 posts 和 experiments）
    const { rows: outcomes } = await pg.query('SELECT * FROM outcome_analysis');
    if (outcomes.length > 0) {
      const outcomeDocs = outcomes.map((row: any) => {
        const { id, ...rest } = row;
        const doc: any = { ...rest };
        if (doc.experiment_id && idMap.has(doc.experiment_id)) {
          doc.experiment_id = idMap.get(doc.experiment_id);
        }
        if (doc.post_id && postIdMap.has(doc.post_id)) {
          doc.post_id = postIdMap.get(doc.post_id);
        }
        if (doc.calculated_at instanceof Date) doc.calculated_at = doc.calculated_at.toISOString();
        return doc;
      });
      const outcomeResult = await db.collection('outcome_analysis').insertMany(outcomeDocs);
      console.log(`  outcome_analysis: ${outcomeResult.insertedCount} 条`);
    }
  }

  console.log('\n迁移完成!');
  await pg.end();
  await closeDb();
}

main().catch((e) => { console.error('迁移失败:', e); process.exit(1); });
