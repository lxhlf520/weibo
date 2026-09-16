/** 冒烟前置：账号池状态检查 */
import { MongoClient } from 'mongodb';
const c = new MongoClient('mongodb://localhost:27017');
await c.connect();
const accs = await c.db('test_experiment').collection('weibo_accounts')
  .find({}, { projection: { nickname: 1, weibo_uid: 1, status: 1 } }).sort({ _id: 1 }).toArray();
console.log(`账号总数: ${accs.length}`);
accs.forEach((a, i) => console.log(`  [${i}] ${a.status} | ${a.nickname || a.weibo_uid}`));
const by = {};
for (const a of accs) by[a.status] = (by[a.status] || 0) + 1;
console.log('status 分布:', JSON.stringify(by));
await c.close();
