/** 采集进度权威统计（数据库口径） */
import { MongoClient } from 'mongodb';
const c = new MongoClient('mongodb://localhost:27017');
await c.connect();
const sup = c.db('weibo_supplement');
const state = sup.collection('trace_state');
const pas = sup.collection('passive_ai_posts');
const raw = sup.collection('posts_raw');

const byStatus = await state.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();
console.log('队列:', byStatus.map(x => `${x._id}=${x.n}`).join(', '));

const traced = await pas.countDocuments({ status: 'traced' });
const missed = await pas.countDocuments({ status: 'miss' });
const unprocessed = await pas.countDocuments({ status: { $nin: ['traced', 'miss'] } });
console.log(`passive: traced=${traced} | miss=${missed} | 未处理=${unprocessed}`);

const rawN = await raw.countDocuments();
const working = await state.countDocuments({ status: 'working' });
console.log(`posts_raw(命中成果)=${rawN} | 正在处理(working)=${working}`);
console.log(`进度: ${(((traced + missed) / 114224) * 100).toFixed(2)}% (已处理帖 ${traced + missed}/114224)`);
await c.close();
