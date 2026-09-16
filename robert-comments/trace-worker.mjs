/**
 * 溯源采集 worker —— weibo_supplement 补采 Phase 1
 *
 * 任务：对 passive_ai_posts（及后续 post_list）中已知 real_uid 的作者，
 *       翻 mymblog 定位目标帖（时间秒级匹配），写入真实 mid。
 *
 * 架构：多进程 worker，每进程 = 1 个代理 + 分配若干 cookie
 *       任务队列 = trace_state 集合（MongoDB 原子认领，天然断点续传）
 *
 * 用法：
 *   node trace-worker.mjs --init                      # 初始化任务队列（一次性）
 *   node trace-worker.mjs --worker=w1 --cookies=0,1 --rate=3000
 *   # cookie 来源二选一：
 *   #   ① .env 的 WEIBO_COOKIES（默认，多个用 ||| 分隔）
 *   #   ② 平台扫码库：--from-db[=库名]  读 weibo_accounts 中 status=active 的账号（默认库 test_experiment）
 *   #      node trace-worker.mjs --worker=w1 --from-db=test_experiment --cookies=0,1
 *   # 走代理：设置 HTTPS_PROXY 环境变量 + --use-env-proxy flag
 *   #   $env:HTTPS_PROXY='http://user:pass@ip:port'; node --use-env-proxy trace-worker.mjs --worker=w1
 *
 * 产出：
 *   weibo_supplement.posts_raw   命中帖完整原始 JSON（upsert by mid）
 *   weibo_supplement.trace_state 任务进度
 *   passive_ai_posts             real_mid / status 更新
 */
import 'dotenv/config';
import { MongoClient } from 'mongodb';

// ── 参数 ──
const args = Object.fromEntries(process.argv.slice(2).map(s => {
  const m = s.match(/^--([^=]+)=?(.*)$/); return m ? [m[1], m[2] || 'true'] : [s, 'true'];
}));
const WORKER = args.worker || 'w0';
const RATE = Number(args.rate) || 4000;          // 请求间隔 ms（默认 4s ≈ 15 req/min）
const MAX_PAGES = Number(args['max-pages']) || 40;
const COOKIE_IDX = String(args.cookies || '0').split(',').map(Number);
const TOLERANCE_MS = 2000;                        // 时间匹配容差

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseApiTime(s) {
  const m = String(s).match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+\+(\d{4})\s+(\d{4})/);
  if (!m) return null;
  const tzH = Number(m[6]) / 100;
  return Date.UTC(Number(m[7]), MONTHS[m[1]], Number(m[2]), Number(m[3]) - tzH, Number(m[4]), Number(m[5]));
}
function parseLocalTime(s) {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +m[6]);
}
const fmt = (ts) => new Date(ts + 8 * 3600 * 1000).toISOString().replace('T', ' ').substring(0, 19);
const log = (...a) => console.log(`[${WORKER}]`, ...a);

// ── MongoDB ──
const mgo = new MongoClient(process.env.MONGO_URL || 'mongodb://localhost:27017');
await mgo.connect();
const sup = mgo.db('weibo_supplement');
const pas = sup.collection('passive_ai_posts');
const state = sup.collection('trace_state');
const postsRaw = sup.collection('posts_raw');

// ── init：构建任务队列 ──
if (args.init) {
  log('初始化任务队列 ...');
  await state.createIndex({ status: 1, priority: 1 });
  await state.createIndex({ uid: 1 }, { unique: true });
  await postsRaw.createIndex({ mid: 1 }, { unique: true });
  await postsRaw.createIndex({ mblogid: 1 });
  await pas.createIndex({ real_uid: 1 });
  await pas.createIndex({ status: 1, trace_layer: 1 });

  const cursor = pas.aggregate([
    { $match: { real_uid: { $ne: null } } },
    { $group: { _id: '$real_uid', layer: { $first: '$trace_layer' }, targets: { $push: { pid: '$post_id', t: '$post_created_at' } } } },
  ]);
  let n = 0, batch = [];
  for await (const g of cursor) {
    const tss = g.targets.map(x => parseLocalTime(x.t)).filter(t => t != null);
    batch.push({
      updateOne: {
        filter: { uid: g._id },
        update: {
          $set: { layer: g.layer, targets: g.targets, target_ts: tss, updated_at: new Date() },
          $setOnInsert: { uid: g._id, status: 'pending', priority: g.layer === 'direct' ? 1 : 2, retries: 0, claimed_at: null },
        },
        upsert: true,
      },
    });
    n++;
    if (batch.length >= 1000) { await state.bulkWrite(batch, { ordered: false }); batch = []; if (n % 10000 === 0) log(`  ...${n} 任务`); }
  }
  if (batch.length) await state.bulkWrite(batch, { ordered: false });
  const total = await state.countDocuments();
  const pending = await state.countDocuments({ status: 'pending' });
  log(`任务队列就绪: ${total} 个 uid 任务 (pending=${pending})`);
  await mgo.close();
  process.exit(0);
}

// ── cookie 池（本 worker 分配的子集）──
// 来源二选一：① .env 的 WEIBO_COOKIES  ② 平台扫码库 weibo_accounts(status=active)
let ALL_COOKIES = [], cookieMeta = [];
if (args['from-db']) {
  const accDb = args['from-db'] === 'true' ? 'test_experiment' : args['from-db'];
  const accs = await mgo.db(accDb).collection('weibo_accounts')
    .find({ status: 'active' }, { projection: { cookie: 1, nickname: 1, weibo_uid: 1 } })
    .sort({ _id: 1 }).toArray();
  ALL_COOKIES = accs.map(a => a.cookie);
  cookieMeta = accs.map(a => String(a.nickname || a.weibo_uid));
  log(`cookie 来源: ${accDb}.weibo_accounts → ${accs.length} 个 active 账号`);
} else {
  ALL_COOKIES = (process.env.WEIBO_COOKIES || '').split('|||').map(s => s.trim()).filter(Boolean);
  cookieMeta = ALL_COOKIES.map((_, i) => `env#${i}`);
  log(`cookie 来源: .env WEIBO_COOKIES → ${ALL_COOKIES.length} 个`);
}
const cookiePool = COOKIE_IDX.map(i => ({ idx: i, c: ALL_COOKIES[i], label: cookieMeta[i] || `#${i}` })).filter(x => x.c);
if (!cookiePool.length) { console.error(`[${WORKER}] 无可用 cookie（池大小 ${ALL_COOKIES.length}，分配 [${COOKIE_IDX}]）`); process.exit(1); }
const cookieDead = new Set();
let ckCursor = 0;
function getCookie() {
  for (let i = 0; i < cookiePool.length; i++) {
    const x = cookiePool[(ckCursor + i) % cookiePool.length];
    if (!cookieDead.has(x.idx)) { ckCursor = (ckCursor + i + 1) % cookiePool.length; return x; }
  }
  return null;
}
log(`启动: 使用账号=[${cookiePool.map(x => `${x.idx}:${x.label}`).join(', ')}] rate=${RATE}ms maxPages=${MAX_PAGES} proxy=${process.env.HTTPS_PROXY ? 'on' : 'direct'}`);

// ── API（重试 + 风控冷却 + cookie 失效剔除）──
let riskCount = 0;
async function apiGet(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const ck = getCookie();
    if (!ck) throw new Error('ALL_COOKIES_DEAD');
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': UA, 'Cookie': ck.c, 'Referer': 'https://weibo.com/',
          'Accept': 'application/json, text/plain, */*', 'X-Requested-With': 'XMLHttpRequest',
        },
        redirect: 'manual', signal: AbortSignal.timeout(15000),
      });
      if (r.status === 418 || r.status === 403) {
        riskCount++; log(`!! ${r.status} 风控 (累计${riskCount}) → 冷却 300s`);
        await sleep(300000);
        if (riskCount >= 3) throw new Error('RISK_3X_STOP');
        continue;
      }
      let j = null;
      try { j = JSON.parse(await r.text()); } catch { /* HTML 响应 */ }
      if (j && j.ok === -100) { cookieDead.add(ck.idx); log(`账号 ${ck.label}(#${ck.idx}) 登录态失效 (剩 ${cookiePool.length - cookieDead.size})`); continue; }
      return j;
    } catch (e) {
      if (e.message === 'RISK_3X_STOP' || e.message === 'ALL_COOKIES_DEAD') throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ── 认领任务 ──
async function claim() {
  return state.findOneAndUpdate(
    { status: 'pending' },
    { $set: { status: 'working', worker: WORKER, claimed_at: new Date(), updated_at: new Date() } },
    { sort: { priority: 1, _id: 1 }, returnDocument: 'after' },
  );
}

// ── 执行单个 uid 溯源 ──
async function runTask(task) {
  const t0 = Date.now();
  const targets = task.targets.filter(x => parseLocalTime(x.t) != null);
  if (!targets.length) { await finishTask(task, 'done', 0, 0, 'no-valid-target'); return; }
  const targetTs = targets.map(x => ({ pid: x.pid, ts: parseLocalTime(x.t) }));
  const oldestTs = Math.min(...targetTs.map(x => x.ts));
  const pendingPids = new Set(targetTs.map(x => x.pid));
  const hits = [];

  let pages = 0, reason = 'pages-limit';
  for (let page = 1; page <= MAX_PAGES; page++) {
    if (!pendingPids.size) { reason = 'ok'; break; }
    const j = await apiGet(`https://weibo.com/ajax/statuses/mymblog?uid=${task.uid}&page=${page}&feature=0`);
    pages++;
    if (!j) { reason = 'http-error'; break; }
    if (j.ok !== 1) { reason = 'api-fail'; break; }
    const list = j?.data?.list || [];
    if (!list.length) { reason = 'empty'; break; }

    let pageOldest = null;
    for (const s of list) {
      const created = parseApiTime(s.created_at);
      if (created == null) continue;
      if (pageOldest == null || created < pageOldest) pageOldest = created;
      for (const t of targetTs) {
        if (pendingPids.has(t.pid) && Math.abs(created - t.ts) <= TOLERANCE_MS) {
          pendingPids.delete(t.pid);
          hits.push({ pid: t.pid, mid: s.mid, mblogid: s.mblogid || s.mid, status: s });
          break;
        }
      }
    }
    // 翻过最老目标时间 → 停止（列表时间倒序）
    if (pageOldest != null && pageOldest < oldestTs - TOLERANCE_MS) { reason = pendingPids.size ? 'overshoot' : 'ok'; break; }
    await sleep(RATE);
  }

  // 写库：命中帖
  if (hits.length) {
    const now = new Date().toISOString();
    await postsRaw.bulkWrite(hits.map(h => ({
      updateOne: {
        filter: { mid: h.mid },
        update: {
          $set: { raw: h.status, mblogid: h.mblogid, uid: task.uid, updated_at: now, source: 'trace' },
          $setOnInsert: { mid: h.mid, collected_at: now },
        },
        upsert: true,
      },
    })), { ordered: false });
    await pas.bulkWrite(hits.map(h => ({
      updateOne: { filter: { post_id: h.pid }, update: { $set: { real_mid: h.mid, status: 'traced', traced_at: now } } },
    })), { ordered: false });
    const missPids = [...pendingPids];
    if (missPids.length) {
      await pas.bulkWrite(missPids.map(pid => ({
        updateOne: { filter: { post_id: pid }, update: { $set: { status: 'miss', traced_at: now } } },
      })), { ordered: false });
    }
  } else {
    await pas.updateMany(
      { post_id: { $in: targets.map(x => x.pid) } },
      { $set: { status: 'miss', traced_at: new Date().toISOString() } },
    );
  }

  const status = hits.length ? (pendingPids.size ? 'partial' : 'done') : 'missed';
  await finishTask(task, status, pages, hits.length, reason, oldestTs);
  log(`uid=${task.uid} [${task.layer}] ${pages}页 命中${hits.length}/${targets.length} ${reason} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

async function finishTask(task, status, pages, hits, reason, oldestTs) {
  await state.updateOne({ uid: task.uid }, {
    $set: {
      status: ['done', 'partial', 'missed'].includes(status) ? 'finished' : status,
      result: status, pages, hits, reason,
      last_target_ts: oldestTs, worker: WORKER, done_at: new Date(), updated_at: new Date(),
    },
  });
}

// ── 主循环 ──
let done = 0, exitCode = 0;
for (;;) {
  const task = await claim();
  if (!task) { log('队列已空，退出'); break; }
  try {
    await runTask(task);
    done++;
    if (done % 50 === 0) {
      const left = await state.countDocuments({ status: 'pending' });
      log(`=== 已完成 ${done} 任务, 剩余 pending=${left} ===`);
    }
  } catch (e) {
    log(`任务失败 uid=${task.uid}: ${e.message}`);
    // 先退还任务（任何退出路径都不让任务卡在 working）
    await state.updateOne({ uid: task.uid }, { $set: { status: 'pending', worker: null, last_error: String(e.message).substring(0, 200), updated_at: new Date() }, $inc: { retries: 1 } });
    if (e.message === 'ALL_COOKIES_DEAD') { log('全部 cookie 失效，退出（任务已退还）'); exitCode = 2; break; }
    if (e.message === 'RISK_3X_STOP') { log('连续风控 3 次，退出（任务已退还）'); exitCode = 3; break; }
  }
  await sleep(RATE);
}
await mgo.close();
process.exitCode = exitCode;
