import { NextRequest, NextResponse } from 'next/server';
import { query, maybeOne, insert, updateOne } from '@/lib/db';
import { getQrCode, checkQrCode, getUserInfo, AccountInfo } from '@/lib/weibo-auth';

const qrSessions = new Map<string, { qrid: string; cookies: string; createdAt: number }>();

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action } = body;

    switch (action) {
      case 'qr_image': {
        const result = await getQrCode();
        const sessionId = crypto.randomUUID();
        qrSessions.set(sessionId, { qrid: result.qrid, cookies: result.cookies, createdAt: Date.now() });
        for (const [key, value] of qrSessions) {
          if (Date.now() - value.createdAt > 300000) qrSessions.delete(key);
        }
        return NextResponse.json({ success: true, imageUrl: result.imageUrl, qrid: result.qrid, sessionId });
      }

      case 'qr_check': {
        const { qrid, sessionId } = body;
        if (!qrid || !sessionId) return NextResponse.json({ error: '缺少 qrid 或 sessionId' }, { status: 400 });
        const session = qrSessions.get(sessionId);
        if (!session) return NextResponse.json({ error: '会话已过期' }, { status: 400 });

        const result = await checkQrCode(qrid, session.cookies);
        console.log('[weibo-login] check result status:', result.status, 'cookies length:', result.cookies?.length);
        if (result.status === 'confirmed') {
          qrSessions.delete(sessionId);
          const finalCookies = result.cookies || session.cookies;
          // 打印所有 cookie 名称，确认是否包含 SUB
          const cookieNames = finalCookies.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
          console.log('[weibo-login] cookie names:', cookieNames.join(', '));
          console.log('[weibo-login] confirmed, cookie snippet:', finalCookies.substring(0, 150));
          console.log('[weibo-login] full cookies:', finalCookies.substring(0, 500));
          let userInfo: AccountInfo | null = null;
          try { 
            userInfo = await getUserInfo(finalCookies); 
            console.log('[weibo-login] getUserInfo result:', userInfo ? `uid=${userInfo.uid} nickname=${userInfo.nickname}` : 'null');
          } catch (e) { 
            console.error('[weibo-login] getUserInfo error:', e);
          }

          if (userInfo) {
            const existing = await maybeOne(
              'accounts',
              { weibo_uid: userInfo.uid },
            );
            if (existing) {
              await updateOne(
                'accounts',
                { id: existing.id },
                { cookie: finalCookies, nickname: userInfo.nickname, avatar: userInfo.avatar, status: 'active', updated_at: new Date().toISOString() },
              );
            } else {
              await insert('accounts', {
                cookie: finalCookies, weibo_uid: userInfo.uid,
                nickname: userInfo.nickname, avatar: userInfo.avatar, status: 'active',
              });
            }
          }
          return NextResponse.json({ success: true, status: 'confirmed', uid: userInfo?.uid, nickname: userInfo?.nickname });
        }
        return NextResponse.json({ success: true, status: result.status, message: result.message });
      }

      case 'save': {
        const { cookie } = body;
        if (!cookie) return NextResponse.json({ error: 'Cookie不能为空' }, { status: 400 });
        let userInfo: AccountInfo | null = null;
        try { userInfo = await getUserInfo(cookie); } catch { return NextResponse.json({ error: 'Cookie无效' }, { status: 400 }); }
        if (!userInfo) return NextResponse.json({ error: 'Cookie无效' }, { status: 400 });

        const existing = await maybeOne(
          'accounts',
          { weibo_uid: userInfo.uid },
        );
        if (existing) {
          await updateOne(
            'accounts',
            { id: existing.id },
            { cookie, nickname: userInfo.nickname, avatar: userInfo.avatar, status: 'active', updated_at: new Date().toISOString() },
          );
        } else {
          await insert('accounts', {
            cookie, weibo_uid: userInfo.uid,
            nickname: userInfo.nickname, avatar: userInfo.avatar, status: 'active',
          });
        }
        return NextResponse.json({ success: true, uid: userInfo.uid, nickname: userInfo.nickname });
      }

      default:
        return NextResponse.json({ error: '无效action，支持: qr_image / qr_check / save' }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json({ error: `请求失败: ${err}` }, { status: 500 });
  }
}
