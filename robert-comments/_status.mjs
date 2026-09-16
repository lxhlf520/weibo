/** 采集状态监控：队列进度 / 卡死任务 / 速率 / 结果分布 / 风控信号 */
import { MongoClient } from 'mongodb';
const mgo = new MongoClient('mongodb://localhost:27017');
await mgo.connect();
const sup = mgo.db('weibo_supplement');
const ts = sup.collection('trace_state');
const pas = sup.collection('passive_ai_posts');

const [pending, working, finished] = await Promise.all([
  ts.countDocuments({ status: 'pending' }),
  ts.countDocuments({ status: 'working' }),
  ts.countDocuments({ status: 'finished' }),
]);
console.log(`trace_state: pending ${pending} | working ${working} | finished ${finished} / 42311`);

const now = Date.now();
const w = await ts.find({ status: 'working' }).sort({ claimed_at: 1 }).toArray();
for (const t of w) {
  const age = ((now - t.claimed_at.getTime()) / 60000).toFixed(1);
  console.log(`  working uid=${t.uid} worker=${t.worker} age=${age}min`);
}

const h1 = new Date(now - 3600 * 1000);
console.log('近1h完成:', await ts.countDocuments({ status: 'finished', done_at: { $gte: h1 } }));
const h6 = new Date(now - 6 * 3600 * 1000);
console.log('近6h完成:', await ts.countDocuments({ status: 'finished', done_at: { $gte: h6 } }));

console.log('result 分布:');
for (const r of await ts.distinct('result')) {
  console.log(`  result=${r}:`, await ts.countDocuments({ result: r }));
}
console.log('reason 分布:');
for (const r of await ts.distinct('reason')) {
  console.log(`  reason=${r}:`, await ts.countDocuments({ reason: r }));
}

console.log('passive_ai_posts: pending', await pas.countDocuments({ status: 'pending' }),
  '| traced', await pas.countDocuments({ status: 'traced' }),
  '| miss', await pas.countDocuments({ status: 'miss' }));
console.log('posts_raw 命中帖:', await sup.collection('posts_raw').countDocuments());

// 最近完成的任务（看时效性）
const last = await ts.find({ status: 'finished' }).sort({ done_at: -1 }).limit(3).toArray();
for (const t of last) {
  console.log(`  最近完成: uid=${t.uid} ${t.result} ${t.pages}页 命中${t.hits} ${t.reason} done=${t.done_at.toISOString()}`);
}
await mgo.close();
