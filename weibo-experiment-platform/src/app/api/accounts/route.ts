import { NextRequest, NextResponse } from 'next/server';
import { query, maybeOne, insert, updateOne, deleteMany } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    const { rows } = await query(
      'accounts',
      {},
      { sort: { created_at: -1 } },
    );
    return NextResponse.json({ accounts: rows });
  } catch (err) {
    return NextResponse.json({ error: `获取账号列表失败: ${err}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cookie, weibo_uid, nickname, avatar } = body;
    if (!cookie) return NextResponse.json({ error: 'Cookie不能为空' }, { status: 400 });

    let action = 'created';
    let account: Record<string, unknown> | null = null;

    if (weibo_uid) {
      const existing = await maybeOne(
        'accounts',
        { weibo_uid },
      );
      if (existing) {
        const account = await updateOne(
          'accounts',
          { id: existing.id },
          { cookie, nickname: nickname || null, avatar: avatar || null, updated_at: new Date().toISOString() },
        );
        action = 'updated';
        return NextResponse.json({ success: true, account, action });
      }
    }

    account = await insert('accounts', {
      cookie, weibo_uid: weibo_uid || null,
      nickname: nickname || null, avatar: avatar || null, status: 'active',
      daily_comment_count: 0, max_daily_comments: 100,
    });
    return NextResponse.json({ success: true, account, action });
  } catch (err) {
    return NextResponse.json({ error: `保存账号失败: ${err}` }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const { id } = await request.json();
    if (!id) return NextResponse.json({ error: '缺少账号ID' }, { status: 400 });
    await deleteMany('accounts', { id });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `删除账号失败: ${err}` }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, status, cookie, daily_comment_count, nickname, avatar, can_comment } = body;
    if (!id) return NextResponse.json({ error: '缺少账号ID' }, { status: 400 });

    const sets: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (status !== undefined) sets.status = status;
    if (cookie !== undefined) sets.cookie = cookie;
    if (daily_comment_count !== undefined) sets.daily_comment_count = daily_comment_count;
    if (nickname !== undefined) sets.nickname = nickname;
    if (avatar !== undefined) sets.avatar = avatar;
    if (can_comment !== undefined) sets.can_comment = can_comment;

    const account = await updateOne(
      'accounts',
      { id },
      sets,
    );
    return NextResponse.json({ success: true, account });
  } catch (err) {
    return NextResponse.json({ error: `更新账号失败: ${err}` }, { status: 500 });
  }
}
