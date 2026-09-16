/**
 * MongoDB 库导出/导入（零额外工具，替代 mongodump/mongorestore）
 * 使用 EJSON 无损序列化（ObjectId / Date / Binary 等类型完整保留）
 *
 * 用法:
 *   node _db-transfer.mjs export <db> [outDir]   # 导出（默认 outDir=./_dump）
 *   node _db-transfer.mjs import <db> [inDir]    # 导入（默认 inDir=./_dump）
 *   node _db-transfer.mjs list                   # 列出本机所有库
 *
 * 文件布局: <dir>/<db>/<collection>.jsonl + <collection>.meta.json(索引定义)
 * 导入策略: 先插数据(ordered:false 跳过重复键)，后建索引
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { MongoClient, BSON } from 'mongodb';
const EJSON = BSON.EJSON;

const [MODE, DBNAME, DIR = '_dump'] = process.argv.slice(2);
if (!MODE) { console.log('用法: node _db-transfer.mjs export|import|list <db> [dir]'); process.exit(1); }

const mgo = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017');
await mgo.connect();

if (MODE === 'list') {
  const admin = mgo.db('admin');
  const res = await admin.command({ listDatabases: 1 });
  for (const d of res.databases) console.log(`${d.name}  ${(d.sizeOnDisk / 1024 / 1024).toFixed(1)} MB`);
  await mgo.close();
  process.exit(0);
}

if (!DBNAME) { console.error('缺少 db 名'); process.exit(1); }
const db = mgo.db(DBNAME);

if (MODE === 'export') {
  const outDir = path.resolve(DIR, DBNAME);
  fs.mkdirSync(outDir, { recursive: true });
  const cols = await db.listCollections().toArray();
  console.log(`导出 ${DBNAME}: ${cols.length} 个集合 → ${outDir}`);
  for (const info of cols) {
    const col = db.collection(info.name);
    const n = await col.estimatedDocumentCount();
    const t0 = Date.now();
    // meta: 索引定义
    const indexes = await col.indexes().catch(() => []);
    fs.writeFileSync(path.join(outDir, `${info.name}.meta.json`), JSON.stringify({ name: info.name, indexes }, null, 1));
    // 文档 → JSONL
    const outStream = fs.createWriteStream(path.join(outDir, `${info.name}.jsonl`));
    let cnt = 0, buf = '';
    for await (const doc of col.find({})) {
      buf += EJSON.stringify(doc, { relaxed: false }) + '\n';
      cnt++;
      if (buf.length > 1_000_000) { // 1MB 批量刷盘
        if (!outStream.write(buf)) await new Promise(r => outStream.once('drain', r));
        buf = '';
      }
    }
    if (buf) outStream.write(buf);
    await new Promise(r => outStream.end(r));
    console.log(`  ${info.name}: ${cnt} 条 (≈${n}), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log('导出完成');
} else if (MODE === 'import') {
  const inDir = path.resolve(DIR, DBNAME);
  if (!fs.existsSync(inDir)) { console.error('目录不存在: ' + inDir); process.exit(1); }
  const metas = fs.readdirSync(inDir).filter(f => f.endsWith('.meta.json'));
  console.log(`导入 ${DBNAME}: ${metas.length} 个集合 ← ${inDir}`);
  for (const mf of metas) {
    const meta = JSON.parse(fs.readFileSync(path.join(inDir, mf), 'utf-8'));
    const col = db.collection(meta.name);
    const jsonl = path.join(inDir, `${meta.name}.jsonl`);
    if (!fs.existsSync(jsonl)) continue;
    const t0 = Date.now();
    const rl = (await import('readline')).createInterface({ input: fs.createReadStream(jsonl, { encoding: 'utf8' }), crlfDelay: Infinity });
    let batch = [], cnt = 0, dup = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line));
      if (batch.length >= 2000) {
        try { await col.insertMany(batch, { ordered: false }); } catch (e) { if (e.code === 11000) dup += e.writeErrors?.length || 1; else throw e; }
        cnt += batch.length; batch = [];
      }
    }
    if (batch.length) {
      try { await col.insertMany(batch, { ordered: false }); } catch (e) { if (e.code === 11000) dup += e.writeErrors?.length || 1; else throw e; }
      cnt += batch.length;
    }
    // 建索引（唯一索引可能因历史重复失败 → 跳过非 _id_）
    for (const ix of meta.indexes || []) {
      if (ix.name === '_id_') continue;
      try { await col.createIndex(ix.key, { name: ix.name, unique: !!ix.unique, sparse: !!ix.sparse }); }
      catch (e) { console.log(`    [warn] 索引 ${ix.name} 建立失败: ${e.message?.substring(0, 80)}`); }
    }
    console.log(`  ${meta.name}: ${cnt} 条 (重复跳过 ${dup}), ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log('导入完成');
} else {
  console.error('未知模式: ' + MODE);
}
await mgo.close();
