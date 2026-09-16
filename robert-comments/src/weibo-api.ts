/**
 * 微博 API 封装 — 返回原始 JSON 响应
 * 所有数据原封不动保存，不做任何整理过滤
 */
import {
  PC_UA, COOKIES,
  POST_INTERVAL_MS, POST_INTERVAL_JITTER,
  COMMENT_PAGE_INTERVAL_MS, COMMENT_PAGE_JITTER,
  RATE_LIMIT_PAUSE_MS, MAX_RETRIES, RETRY_DELAY_MS,
  sleep, randomDelay,
} from './config';

// ─── Cookie 轮换 ──────────────────────────────────────────
let cookieIdx = 0;
const cookieExhausted = new Set<number>();

function getCookie(): string {
  if (COOKIES.length === 0) throw new Error('未配置 WEIBO_COOKIES');
  for (let i = 0; i < COOKIES.length; i++) {
    const idx = (cookieIdx + i) % COOKIES.length;
    if (!cookieExhausted.has(idx)) {
      cookieIdx = (idx + 1) % COOKIES.length;
      return COOKIES[idx];
    }
  }
  throw new Error('所有 Cookie 均已过期');
}

export function markCookieExpired(): void {
  const lastIdx = cookieIdx > 0 ? cookieIdx - 1 : COOKIES.length - 1;
  cookieExhausted.add(lastIdx);
  console.log(`[API] Cookie 过期，剩余: ${COOKIES.length - cookieExhausted.size}/${COOKIES.length}`);
}

// ─── 请求头 ───────────────────────────────────────────────
function getXsrf(cookies: string): string {
  return cookies.match(/XSRF-TOKEN=([^;]+)/)?.[1] || '';
}

function headers(cookies: string): Record<string, string> {
  return {
    'User-Agent': PC_UA,
    'Cookie': cookies,
    'X-XSRF-TOKEN': getXsrf(cookies),
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://weibo.com/',
    'Accept': 'application/json, text/plain, */*',
  };
}

// ─── 带重试的 fetch ───────────────────────────────────────
async function fetchRaw(url: string, opts?: RequestInit): Promise<any | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const cookie = getCookie();
      const resp = await fetch(url, {
        ...opts,
        headers: { ...headers(cookie), ...opts?.headers },
        redirect: 'follow',
      });

      if (resp.url?.includes('login.sina.com.cn')) {
        markCookieExpired();
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY_MS); continue; }
        return null;
      }

      if (resp.status === 403 || resp.status === 429) {
        console.log(`[API] 限流 ${resp.status}，暂停 ${RATE_LIMIT_PAUSE_MS / 1000}s`);
        await sleep(RATE_LIMIT_PAUSE_MS);
        if (attempt < MAX_RETRIES) continue;
        return null;
      }

      if (!resp.ok) return null;

      const text = await resp.text();
      try {
        return JSON.parse(text);
      } catch {
        return null; // HTML 响应（如登录页）
      }
    } catch (err) {
      console.error(`[API] 请求失败 attempt=${attempt + 1} url=${url.substring(0, 80)}`);
      if (attempt < MAX_RETRIES) await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

// ─── 搜索帖子 mid（HTML 接口）────────────────────────────

export async function searchPostMids(
  keyword: string,
  page: number,
  timeScope?: string,
): Promise<string[]> {
  const params = new URLSearchParams({ q: keyword, page: String(page) });
  if (timeScope) params.set('timescope', timeScope);

  const url = `https://s.weibo.com/realtime?${params.toString()}`;

  // 带重试：网络异常（ECONNRESET 等）不能让采集整体崩掉，按空结果返回由上层退避处理
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const cookie = getCookie();
      const resp = await fetch(url, {
        headers: {
          'User-Agent': PC_UA,
          'Cookie': cookie,
          'Referer': 'https://s.weibo.com/',
          'Accept': 'text/html,application/xhtml+xml',
        },
        redirect: 'follow',
      });

      if (!resp.ok) return [];
      if (resp.url.includes('login.sina.com.cn')) {
        markCookieExpired();
        return [];
      }

      const html = await resp.text();
      return [...html.matchAll(/mid="(\d+)"/g)].map(m => m[1]);
    } catch {
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS);
        continue;
      }
    }
  }
  return [];
}

/** 构建 timescope 参数: custom:2026-08-01-0:2026-08-01-23（custom 前缀为微博高级搜索日期过滤必需） */
export function buildTimeScope(date: string): string {
  return `custom:${date}-0:${date}-23`;
}

// ─── 帖子详情原始数据 ─────────────────────────────────────

/** GET /ajax/statuses/show?id={mid} → 原始 JSON */
export async function fetchPostRaw(mid: string): Promise<any | null> {
  return fetchRaw(`https://weibo.com/ajax/statuses/show?id=${mid}`);
}

// ─── 评论原始数据（单页）──────────────────────────────────

/** GET /ajax/statuses/buildComments → 原始 JSON */
export async function fetchCommentsRaw(
  mid: string,
  maxId?: string,
): Promise<any | null> {
  const params = new URLSearchParams({
    id: mid,
    is_show_bulletin: '2',
    is_mix: '0',
    count: '20',
    fetch_level: '0',
  });
  if (maxId) params.set('max_id', maxId);

  return fetchRaw(`https://weibo.com/ajax/statuses/buildComments?${params.toString()}`);
}

/** GET /ajax/statuses/buildComments?rootid=xxx → 获取子评论 */
export async function fetchSubCommentsRaw(
  mid: string,
  rootId: string,
  maxId?: string,
): Promise<any | null> {
  const params = new URLSearchParams({
    id: mid,
    rootid: rootId,
    is_show_bulletin: '2',
    is_mix: '0',
    count: '20',
    fetch_level: '1',
  });
  if (maxId) params.set('max_id', maxId);

  return fetchRaw(`https://weibo.com/ajax/statuses/buildComments?${params.toString()}`);
}

/** 获取一级评论下全部子评论原始数据（自动翻页，返回所有页原始 JSON 数组） */
export async function fetchAllSubCommentsRaw(
  mid: string,
  rootId: string,
  maxPages: number = 50,
): Promise<any[]> {
  const pages: any[] = [];
  let maxId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchSubCommentsRaw(mid, rootId, maxId);
    if (!raw) break;

    pages.push(raw);

    const comments = raw?.data;
    if (!comments || !Array.isArray(comments) || comments.length === 0) break;
    const nextMaxId = raw?.max_id;
    if (!nextMaxId) break;
    maxId = String(nextMaxId);

    await sleep(150 + Math.random() * 150);
  }

  return pages;
}

/** 获取帖子全部评论原始数据（自动翻页，返回所有页原始 JSON 数组） */
export async function fetchAllCommentsRaw(
  mid: string,
  maxPages: number = 100,
): Promise<any[]> {
  const pages: any[] = [];
  let maxId: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const raw = await fetchCommentsRaw(mid, maxId);
    if (!raw) break;

    pages.push(raw);

    const nextMaxId = raw?.max_id;
    const comments = raw?.data;
    if (!comments || !Array.isArray(comments) || comments.length === 0) break;
    if (!nextMaxId) break;
    maxId = String(nextMaxId);

    await randomDelay(COMMENT_PAGE_INTERVAL_MS, COMMENT_PAGE_JITTER);
  }

  return pages;
}

// ─── 用户信息原始数据 ─────────────────────────────────────

/** GET /ajax/profile/info?uid={uid} → 原始 JSON */
export async function fetchUserRaw(uid: string): Promise<any | null> {
  return fetchRaw(`https://weibo.com/ajax/profile/info?uid=${uid}`);
}

// ─── 用户微博列表 ─────────────────────────────────────────

/** GET /ajax/statuses/mymblog → 原始 JSON */
export async function fetchUserPostsRaw(uid: string, page: number = 1): Promise<any | null> {
  return fetchRaw(`https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`);
}

// ─── 热搜榜 ───────────────────────────────────────────────

/** GET /ajax/side/hotSearch → 热搜关键词列表 */
export async function fetchHotSearchKeywords(): Promise<string[]> {
  const raw = await fetchRaw('https://weibo.com/ajax/side/hotSearch');
  if (!raw?.ok) return [];

  const keywords: string[] = [];
  const realtime = raw?.data?.realtime || [];
  for (const item of realtime) {
    const word = item.word || item.note || '';
    if (word) keywords.push(word);
  }
  return keywords;
}

// ─── 速率控制 ─────────────────────────────────────────────
export async function postDelay(): Promise<void> {
  await randomDelay(POST_INTERVAL_MS, POST_INTERVAL_JITTER);
}
