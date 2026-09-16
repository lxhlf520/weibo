import { NextRequest, NextResponse } from 'next/server';
import { ObjectId } from 'mongodb';
import { getSupplementDb } from '@/lib/db';

export const dynamic = 'force-dynamic';

/** 本地时区今日 0 点对应的 ObjectId 下界（ObjectId 前 4 字节为创建时间戳）：用于"当日"统计 */
function dayStartObjectId(): ObjectId {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const hex = Math.floor(d.getTime() / 1000).toString(16).padStart(8, '0');
  return new ObjectId(hex + '0'.repeat(16));
}

/**
 * 采集数据总览统计（数据源：采集库 weibo_supplement）
 * - 数据总量：帖子清单 + AI曝光帖 + 作者归档 + 采集原始帖 + UID映射 的文档总和
 * - Post 数：帖子清单总量；当日 = 今日新采集入库的帖（posts_raw 新增）
 * - 评论数：AI 曝光帖关联评论合计（focal_comment_count）
 * - 用户数：UID 映射收录用户数（hash_uid_map）
 */
export async function GET(request: NextRequest) {
  try {
    const db = await getSupplementDb();
    const dayOid = dayStartObjectId();

    const postList = db.collection('post_list');
    const passive = db.collection('passive_ai_posts');
    const archive = db.collection('weibbo_posts_archive');
    const postsRaw = db.collection('posts_raw');
    const hashUid = db.collection('hash_uid_map');

    const [
      plTotal, plToday,
      pasTotal, pasToday,
      arcTotal, arcToday,
      rawTotal, rawToday,
      uidTotal, uidToday,
      focalAllRes, focalTodayRes,
    ] = await Promise.all([
      postList.estimatedDocumentCount(),
      postList.countDocuments({ _id: { $gte: dayOid } }),
      passive.estimatedDocumentCount(),
      passive.countDocuments({ _id: { $gte: dayOid } }),
      archive.estimatedDocumentCount(),
      archive.countDocuments({ _id: { $gte: dayOid } }),
      postsRaw.estimatedDocumentCount(),
      postsRaw.countDocuments({ _id: { $gte: dayOid } }),
      hashUid.estimatedDocumentCount(),
      hashUid.countDocuments({ _id: { $gte: dayOid } }),
      passive.aggregate([
        { $group: { _id: null, s: { $sum: '$focal_comment_count' } } },
      ]).toArray(),
      passive.aggregate([
        { $match: { _id: { $gte: dayOid } } },
        { $group: { _id: null, s: { $sum: '$focal_comment_count' } } },
      ]).toArray(),
    ]);

    const focalAll = focalAllRes[0]?.s || 0;
    const focalToday = focalTodayRes[0]?.s || 0;

    // 数据总量 = 各数据集合文档总和；当日 = 各集合今日新增之和
    const dataTotal = plTotal + pasTotal + arcTotal + rawTotal + uidTotal;
    const dataToday = plToday + pasToday + arcToday + rawToday + uidToday;

    return NextResponse.json({
      data: { total: dataTotal, today: dataToday },
      posts: { total: plTotal, today: rawToday },
      comments: { total: focalAll, today: focalToday },
      users: { total: uidTotal, today: uidToday },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return NextResponse.json({ error: `统计数据获取失败: ${err}` }, { status: 500 });
  }
}
