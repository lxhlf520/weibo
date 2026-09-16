/**
 * 微博PC端认证服务
 * 基于 passport.weibo.com 的扫码登录流程
 */

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PASSPORT_PC_API = 'https://passport.weibo.com';

export interface QrCodeResult {
  imageUrl: string;
  qrid: string;
  cookies: string;
}

export interface QrCheckResult {
  status: 'waiting' | 'scanned' | 'confirmed' | 'expired';
  message?: string;
  redirectUrl?: string;
  cookies?: string;
  uid?: string;
}

export interface LoginResult {
  success: boolean;
  cookie: string;
  uid?: string;
  nickname?: string;
}

export interface AccountInfo {
  uid: string;
  nickname: string;
  avatar: string;
}

/**
 * 获取PC端初始会话（CSRF token + cookies）
 */
export async function getPcSession(): Promise<string> {
  const resp = await fetch(`${PASSPORT_PC_API}/sso/signin?entry=miniblog&source=miniblog`, {
    headers: { 'User-Agent': PC_UA },
    redirect: 'manual',
  });

  const setCookie = resp.headers.get('set-cookie');
  if (!setCookie) throw new Error('获取PC端会话失败：无Set-Cookie');

  // 提取关键 cookie：TIEBA_USERTYPE, SUB, SUBP 等
  return parseCookies(setCookie);
}

/**
 * 获取扫码登录二维码
 */
export async function getQrCode(): Promise<QrCodeResult> {
  const sessionCookies = await getPcSession();

  // entry=weibo 表示微博客户端扫码, gid=102803, size=180 二维码尺寸
  const resp = await fetch(
    `${PASSPORT_PC_API}/sso/v2/qrcode/image?entry=weibo&gid=102803&size=180&url=`,
    {
      headers: { 'User-Agent': PC_UA, Cookie: sessionCookies, Referer: `${PASSPORT_PC_API}/sso/signin` },
      redirect: 'manual',
    },
  );

  const newCookies = mergeCookies(sessionCookies, resp.headers.get('set-cookie') || '');
  const data = await resp.json();

  // API 返回格式可能有差异，做兼容处理
  const imageUrl = data.data?.image || data.data?.qrcode || data.image || data.qrcode || '';
  const qrid = data.data?.qrid || data.data?.alt || data.qrid || data.alt || '';

  if (!imageUrl || !qrid) {
    throw new Error(`获取二维码失败: ${JSON.stringify(data)}`);
  }

  // 如果 imageUrl 是相对路径，补全
  let fullImageUrl = imageUrl;
  if (imageUrl.startsWith('//')) {
    fullImageUrl = 'https:' + imageUrl;
  } else if (!imageUrl.startsWith('http')) {
    fullImageUrl = `${PASSPORT_PC_API}${imageUrl}`;
  }

  return { imageUrl: fullImageUrl, qrid, cookies: newCookies };
}

/**
 * 轮询检查二维码扫码状态
 */
export async function checkQrCode(qrid: string, cookies: string): Promise<QrCheckResult> {
  const resp = await fetch(
    `${PASSPORT_PC_API}/sso/v2/qrcode/check?entry=weibo&qrid=${qrid}`,
    {
      headers: {
        'User-Agent': PC_UA,
        Cookie: cookies,
        Referer: `${PASSPORT_PC_API}/sso/signin`,
      },
      redirect: 'manual',
    },
  );

  const data = await resp.json();
  const retcode = data.retcode;
  const msg = data.msg || '';
  // 完整打印响应用于定位问题
  const checkSetCookie = resp.headers.get('set-cookie') || '';
  console.log('[checkQrCode] full response:', JSON.stringify(data));
  console.log('[checkQrCode] set-cookie header:', checkSetCookie.substring(0, 200));

  // retcode 含义（基于实际 API 返回值验证）:
  // 20000000 - 已确认登录（返回 data.url 重定向地址）
  // 50114001 - 等待扫码
  // 50114002 - 已扫码，等待用户在手机确认
  // 50114003 - 二维码过期
  // 50114004 - 已取消/已登录

  if (retcode === 20000000) {
    // 扫码确认成功
    // 合并 check 响应中的新 cookie
    let finalCookies = mergeCookies(cookies, checkSetCookie);
    const redirectUrl = data.data?.url || '';
    
    if (redirectUrl) {
      console.log('[checkQrCode] following redirectUrl');
      finalCookies = await followSsoRedirect(redirectUrl, finalCookies);
    } else {
      console.log('[checkQrCode] no redirectUrl, trying weibo.com directly');
      finalCookies = await followSsoRedirect('https://weibo.com/', finalCookies);
    }
    return { status: 'confirmed', cookies: finalCookies, uid: extractUid(finalCookies) };
  } else if (retcode === 50114001) {
    // 等待扫码
    return { status: 'waiting' };
  } else if (retcode === 50114002) {
    // 已扫码，等待用户在手机确认
    return { status: 'scanned', message: msg || '已扫码，请在手机上确认' };
  } else if (retcode === 50114003) {
    return { status: 'expired', message: '二维码已过期，请刷新' };
  } else if (retcode === 50114004) {
    return { status: 'expired', message: '二维码已被取消，请重新获取' };
  }

  // 默认：继续等待
  return { status: 'waiting' };
}

/**
 * 跟随SSO重定向链，获取weibo.com域名的最终Cookie
 */
async function followSsoRedirect(redirectUrl: string, existingCookies: string): Promise<string> {
  let url = redirectUrl;
  let allCookies = existingCookies;
  let maxRedirects = 10;
  let prevUrl = ''; // 用于 Referer 链

  while (maxRedirects > 0) {
    const headers: Record<string, string> = {
      'User-Agent': PC_UA,
      Cookie: allCookies,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    };
    // 微博 SSO 严格校验 Referer 和 Origin
    if (prevUrl) {
      headers['Referer'] = prevUrl;
      try { headers['Origin'] = new URL(prevUrl).origin; } catch {}
    }

    const resp = await fetch(url, {
      headers,
      redirect: 'manual',
      credentials: 'include',
    });

    const setCookieHeader = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [resp.headers.get('set-cookie') || ''];
    const location = resp.headers.get('location') || '';
    console.log('[followSsoRedirect] step', 10 - maxRedirects, 'status:', resp.status, 'cookies:', setCookieHeader.length || 0, 'location:', location.substring(0, 100));
    if (Array.isArray(setCookieHeader) ? setCookieHeader.filter(Boolean).length > 0 : setCookieHeader) {
      allCookies = mergeCookies(allCookies, setCookieHeader);
    }

    // 非 3xx 响应（跨域 cookie 设置页、或错误）
    if (resp.status < 300 || resp.status >= 400) {
      const body = await resp.text().catch(() => '');
      console.log('[followSsoRedirect] final page status:', resp.status, 'url:', url.substring(0, 60), 'body:', body.substring(0, 500));
      if (url.includes('crossdomain') || url.includes('weibo.com')) {
        allCookies = parseCookiesFromHtml(allCookies, body);
      }
      break;
    }

    prevUrl = url;
    url = location.startsWith('http') ? location : `https://weibo.com${location}`;
    maxRedirects--;
  }

  return allCookies;
}

/**
 * 从 crossdomain HTML 响应中提取 cookie
 * 微博 SSO crossdomain 返回的 HTML 中含 document.cookie 赋值脚本
 */
function parseCookiesFromHtml(existingCookies: string, html: string): string {
  const cookieRegex = /document\.cookie\s*=\s*["']([^"']+)["']/g;
  let match;
  let newCookies = existingCookies;
  while ((match = cookieRegex.exec(html)) !== null) {
    newCookies = mergeCookies(newCookies, match[1]);
    console.log('[parseCookiesFromHtml] extracted:', match[1].substring(0, 80));
  }
  return newCookies;
}

/**
 * 过滤只保留 weibo.com 域名的 cookie，排除 passport、sina 等无关域名
 */
function filterWeiboCookies(cookies: string): string {
  // 属于 weibo.com 域的标准 cookie
  const weiboOnly = ['SUB', 'SUBP', 'SCF', 'XSRF-TOKEN', 'WBPSESS', 'SSOLoginState'];
  const pairs = cookies.split(';').map(c => c.trim()).filter(Boolean);
  const filtered = pairs.filter(p => {
    const name = p.split('=')[0].trim();
    return weiboOnly.includes(name);
  });
  return filtered.join('; ');
}

/**
 * 从微博首页 HTML 提取用户信息（绕过 API WAF）
 */
function extractUserFromHtml(html: string): AccountInfo | null {
  // 先尝试 __NEXT_DATA__（新版微博 React SPA）
  const ndMatch = html.match(/<script\s+id=["']__NEXT_DATA__["']\s+type=["']application\/json["']>([^<]+)<\/script>/);
  if (ndMatch) {
    try {
      const nd = JSON.parse(ndMatch[1]);
      const user = nd?.props?.pageProps?.user || nd?.props?.pageProps?.userInfo || {};
      if (user.id || user.idstr) {
        return {
          uid: String(user.id || user.idstr),
          nickname: user.screen_name || user.name || '',
          avatar: user.avatar_hd || user.profile_image_url || user.avatar_large || '',
        };
      }
    } catch { /* ignore */ }
  }

  // 尝试 title 中的昵称: "xxx的微博"
  const titleMatch = html.match(/<title>([^<]+)的微博<\/title>/);
  // 尝试 CONFIG 模式
  const uidMatch = html.match(/\$CONFIG\[?'?"?user_id'?"?\]?\s*=\s*['"](\d+)['"]/)
    || html.match(/\$CONFIG\[?'?"?oid'?"?\]?\s*=\s*['"](\d+)['"]/)
    || html.match(/user_id\s*:\s*['"](\d+)['"]/);
  
  const uid = uidMatch?.[1];
  if (!uid) return null;

  const nickMatch = html.match(/nickname\s*[:=]\s*['"]([^'"]+)['"]/)
    || html.match(/\$CONFIG\[?'?"?nickname'?"?\]?\s*=\s*['"]([^'"]+)['"]/)
    || titleMatch;
  const nickname = nickMatch?.[1]?.replace(/\\u/g, '%u') || '';

  const avatarMatch = html.match(/profile_image_url\s*[:=]\s*['"]([^'"]+)['"]/);
  const avatar = avatarMatch?.[1] || '';

  return { uid, nickname: nickname || `u${uid}`, avatar };
}

/**
 * 获取微博用户信息（验证Cookie有效性）
 */
export async function getUserInfo(cookies: string): Promise<AccountInfo | null> {
  try {
    // 只保留 weibo.com 域名的 cookie，过滤掉 passport/sina 域名的
    const weiboCookies = filterWeiboCookies(cookies);
    const xsrfToken = extractXsrfToken(weiboCookies);
    const cookieNames = weiboCookies.split(';').map(c => c.trim().split('=')[0]).filter(Boolean).join(', ');
    console.log('[getUserInfo] filtered:', cookieNames, 'xsrfToken:', xsrfToken?.substring(0, 20));

    // 先尝试通过微博首页提取用户信息（更稳定，绕过 API WAF）
    const homeResp = await fetch('https://weibo.com/', {
      headers: {
        'User-Agent': PC_UA,
        Cookie: weiboCookies,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const homeHtml = await homeResp.text();
    console.log('[getUserInfo] homepage status:', homeResp.status, 'length:', homeHtml.length);
    // 搜索关键登录标记
    const hasNick = homeHtml.includes('nickname') || homeHtml.includes('screen_name');
    const hasUser = homeHtml.includes('user_id') || homeHtml.includes('"id"');
    const hasVisitor = homeHtml.includes('Visitor System') || homeHtml.includes('passport.weibo.com');
    console.log('[getUserInfo] homepage hasNick:', hasNick, 'hasUser:', hasUser, 'hasVisitor:', hasVisitor);
    // 打印 500-1000 区域（通常 $CONFIG 在这里）
    console.log('[getUserInfo] homepage mid:', homeHtml.substring(500, 1000));
    // log title for debugging
    const titleDebug = homeHtml.match(/<title>([^<]+)<\/title>/);
    console.log('[getUserInfo] homepage title:', titleDebug?.[1]);
    const homeInfo = extractUserFromHtml(homeHtml);
    if (homeInfo) {
      console.log('[getUserInfo] extracted from homepage:', homeInfo.nickname);
      return homeInfo;
    }

    // 首页提取失败，回退到 API（尝试多个端点）
    console.log('[getUserInfo] homepage extraction failed, trying APIs...');
    const uid = extractUid(weiboCookies);
    console.log('[getUserInfo] extracted uid from SUB:', uid);

    // 尝试 api.weibo.com 公共 API（最稳定的方式）
    let resp = await fetch('https://api.weibo.com/2/account/get_uid.json', {
      headers: {
        'User-Agent': PC_UA,
        Cookie: weiboCookies,
        'Accept': 'application/json',
      },
    });
    if (resp.status === 200) {
      const text = await resp.text();
      console.log('[getUserInfo] api.weibo get_uid:', text.substring(0, 200));
      try {
        const data = JSON.parse(text);
        if (data.uid) return { uid: String(data.uid), nickname: '', avatar: '' };
      } catch {}
    } else {
      console.log('[getUserInfo] api.weibo status:', resp.status);
    }

    // 尝试 m.weibo.cn（移动端，反爬更弱）
    let mUid = uid || '';
    let mNickname = '';
    let mAvatar = '';
    resp = await fetch('https://m.weibo.cn/api/config', {
      headers: {
        'User-Agent': PC_UA,
        Cookie: weiboCookies,
        'Accept': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: 'https://m.weibo.cn/',
      },
    });
    if (resp.status === 200) {
      const text = await resp.text();
      console.log('[getUserInfo] m.weibo config:', text.substring(0, 300));
      try {
        const data = JSON.parse(text);
        if (data.data?.user?.id) {
          const u = data.data.user;
          return { uid: String(u.id), nickname: u.screen_name || '', avatar: u.profile_image_url || u.avatar_hd || '' };
        }
        // 只拿到 uid 没有昵称时不提前返回，继续往下走 profile/info
        if (data.data?.uid) {
          mUid = String(data.data.uid);
          mNickname = data.data.screen_name || '';
          console.log('[getUserInfo] m.weibo got uid:', mUid, 'nickname:', mNickname || '(empty), will try profile/info');
        }
      } catch {}
    } else {
      console.log('[getUserInfo] m.weibo status:', resp.status);
    }

    // 尝试 /ajax/profile/info?uid=xxx 并加 from 参数
    const finalUid = mUid || uid || '';
    const profileUrl = `https://weibo.com/ajax/profile/info${finalUid ? `?uid=${finalUid}` : ''}`;
    resp = await fetch(profileUrl, {
      headers: {
        'User-Agent': PC_UA,
        Cookie: weiboCookies,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'X-Requested-With': 'XMLHttpRequest',
        'X-XSRF-TOKEN': xsrfToken,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        Referer: 'https://weibo.com/',
      },
    });
    const text = await resp.text();
    console.log('[getUserInfo] profile/info status:', resp.status, 'body:', text.substring(0, 250));
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      console.error('[getUserInfo] JSON parse failed, status:', resp.status, 'content-type:', resp.headers.get('content-type'));
      return null;
    }
    console.log('[getUserInfo] api response ok:', data.ok, 'has user:', !!data.data?.user);
    if (!data.data?.user) {
      console.log('[getUserInfo] full response:', JSON.stringify(data).substring(0, 300));
    }
    if (data.ok === 1 && data.data?.user) {
      const user = data.data.user;
      return {
        uid: String(user.id || user.idstr),
        nickname: user.screen_name || user.name || '',
        avatar: user.avatar_hd || user.profile_image_url || '',
      };
    }
    // 兜底：至少从 m.weibo 或 SUB 拿到了 uid
    if (mUid) {
      console.log('[getUserInfo] fallback: returning uid from m.weibo, nickname:', mNickname || '(empty)');
      return { uid: mUid, nickname: mNickname, avatar: mAvatar };
    }
    if (uid) {
      console.log('[getUserInfo] fallback: returning uid from SUB cookie');
      return { uid, nickname: '', avatar: '' };
    }
    return null;
  } catch (e) {
    console.error('[getUserInfo] exception:', e);
    return null;
  }
}

/**
 * 验证Cookie是否仍然有效
 */
export async function verifyCookie(cookies: string): Promise<boolean> {
  const info = await getUserInfo(cookies);
  return info !== null;
}

// ============ 工具函数 ============

function parseCookies(setCookieHeader: string): string {
  if (!setCookieHeader) return '';

  // set-cookie 可能包含多条，用逗号分隔
  const cookies: string[] = [];
  const parts = setCookieHeader.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    const semiIdx = trimmed.indexOf(';');
    const cookieStr = semiIdx > 0 ? trimmed.substring(0, semiIdx) : trimmed;
    if (cookieStr.includes('=')) {
      cookies.push(cookieStr);
    }
  }

  return cookies.join('; ');
}

function mergeCookies(existing: string, newSetCookies: string | string[]): string {
  if (!newSetCookies) return existing;
  const scList = Array.isArray(newSetCookies) ? newSetCookies : [newSetCookies];

  const existingMap = new Map<string, string>();
  if (existing) {
    existing.split(';').forEach((c) => {
      const eqIdx = c.trim().indexOf('=');
      if (eqIdx > 0) {
        existingMap.set(c.trim().substring(0, eqIdx), c.trim());
      }
    });
  }

  for (const sc of scList) {
    if (!sc) continue;
    // 提取 name=value 部分（分号前）
    const semiIdx = sc.indexOf(';');
    const kv = semiIdx > 0 ? sc.substring(0, semiIdx).trim() : sc.trim();
    const eqIdx = kv.indexOf('=');
    if (eqIdx > 0) {
      existingMap.set(kv.substring(0, eqIdx), kv);
    }
  }

  return Array.from(existingMap.values()).join('; ');
}

function extractXsrfToken(cookies: string): string {
  // 尝试多种 CSRF token 来源
  return cookies.match(/XSRF-TOKEN=([^;]+)/)?.[1]
    || cookies.match(/X-CSRF-TOKEN=([^;]+)/)?.[1]
    || '';
}

function extractUid(cookies: string): string | undefined {
  const subMatch = cookies.match(/SUB=([^;]+)/);
  if (!subMatch) return undefined;
  // SUB 格式: _2A25 + base62 数据，尝试从中提取 10 位数字 uid
  const sub = subMatch[1];
  const uidMatch = sub.match(/_(\d{10})/); // 有时 uid 直接嵌在前缀
  if (uidMatch) return uidMatch[1];
  // 尝试正则找 10 位数字
  const fallback = sub.match(/(\d{10})/);
  return fallback?.[1];
}
