/** 暂停收尾：重置 working → pending（硬停止残留）+ 进度快照 */
import { MongoClient } from 'mongodb';
const mgo = new MongoClient('mongodb://localhost:27017');
await mgo.connect();
const sup = mgo.db('weibo_supplement');
const ts = sup.collection('trace_state');

// 1. 重置硬停止残留的 working 任务
const r = await ts.updateMany(
  { status: 'working' },
  { $set: { status: 'pending', worker: null } }
);
console.log('重置 working -> pending:', r.modifiedCount);

// 2. 队列状态快照
const byStatus = await ts.aggregate([
  { $group: { _id: '$status', n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
console.log('\n队列状态:');
byStatus.forEach(x => console.log(`  ${x._id}: ${x.n}`));

const finishedOk = await ts.countDocuments({ status: 'finished', reason: 'ok' });
console.log('\nfinished(ok):', finishedOk);
console.log('posts_raw 命中帖:', await sup.collection('posts_raw').countDocuments());
console.log('passive traced:', await sup.collection('passive_ai_posts').countDocuments({ status: 'traced' }));

await mgo.close();
