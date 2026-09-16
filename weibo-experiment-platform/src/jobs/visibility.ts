/**
 * 正式实验 - 可见性验证模块（微博）
 * ============================================================================
 * 用观察账号（独立普通用户视角）检查机器人评论是否公开可见。
 * 编码规范（文档第七节）：
 *   1    = 独立普通用户视角确认可见
 *   0    = 独立普通用户视角确认不可见
 *   null = 无法验证/抓取失败（网络错误、页面异常、账号异常等一律不得记 0）
 *
 * 检查方法：buildComments 翻页（fetch_level=0 顶层评论）比对 idstr === robot_comment_id
 *   - 找到 → 1
 *   - 翻页完整（max_id 为 null）且未找到 → 0（queryComplete=true）
 *   - 翻页不完整 / HTTP/JSON 异常 → null + failure_reason（queryComplete=false）
 * 规范 P0-3：只有"完整覆盖且未找到"才允许记 0，截断/异常一律 NA。
 */

import { insert, updateOne, query } from '../lib/db';
import { Account, buildHeaders, now } from './shared';

export interface VisibilityResult {
  code: 1 | 0 | null;
  reason?: string;
  /** 查询是否完整覆盖（翻页到底/直查成功）。仅 queryComplete=true 且未找到才允许 code=0 */
  queryComplete?: boolean;
}

/** 翻页上限：每页 50 条 × 10 页 = 500 条顶层评论（实验帖筛选要求评论 5-200） */
const MAX_PAGES = 10;

interface CommentsPage {
  comments: Array<{ idstr?: string }>;
  maxId: string | null;
  total: number;
}

/** 直接请求 buildComments（不使用 weibo-api.getComments，因其吞掉 HTTP 错误无法区分"失败"与"真无评论"） */
async function fetchCommentsPage(cookie: string, mid: string, maxId?: string): Promise<CommentsPage | null> {
  const params = new URLSearchParams({
    id: mid,
    is_show_bulletin: '2',
    is_mix: '1',
    count: '50',
    fetch_level: '0',
  });
  if (maxId) params.set('max_id', maxId);
  try {
    const resp = await fetch(
      `https://weibo.com/ajax/statuses/buildComments?${params.toString()}`,
      { headers: buildHeaders(cookie) },
    );
    if (!resp.ok) return null;
    const text = await resp.text();
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object') return null;
      return {
        comments: Array.isArray(data.data) ? data.data : [],
        maxId: data.max_id || null,
        total: data.total_number || 0,
      };
    } catch {
      return null; // JSON 解析失败（可能被重定向到登录页）
    }
  } catch {
    return null;
  }
}

/**
 * 检查某条机器人评论是否对普通用户可见。
 * @returns code: 1=可见, 0=确认不可见, null=无法验证
 */
export async function checkWeiboVisibility(
  cookie: string,
  mid: string,
  robotCid: string,
): Promise<VisibilityResult> {
  if (!robotCid) return { code: null, reason: 'empty robot_comment_id' };

  let maxId: string | null = null;
  let collected = 0;
  let total = 0;

  for (let page = 0; page < MAX_PAGES; page++) {
    const pageData = await fetchCommentsPage(cookie, mid, maxId || undefined);
    if (!pageData) {
      return { code: null, reason: `page fetch failed at page ${page + 1}`, queryComplete: false };
    }
    total = pageData.total;
    collected += pageData.comments.length;

    for (const c of pageData.comments) {
      if (c?.idstr && String(c.idstr) === String(robotCid)) {
        return { code: 1, queryComplete: true };
      }
    }

    if (!pageData.maxId) {
      // 顶层评论已翻完仍未找到 → 确认不可见（查询完整覆盖）
      return { code: 0, queryComplete: true };
    }
    maxId = pageData.maxId;
  }

  // 翻页不完整（仍存在 max_id）：无法确认，记 NA（规范 P0-3：不完整≠不可见）
  return { code: null, reason: `pagination incomplete (collected=${collected}, total=${total})`, queryComplete: false };
}

/**
 * 用独立观察账号检查可见性；首次判 0 时用第二个观察账号复核（规范建议3）：
 *   A=0,B=0 → 0（双账号确认不可见）
 *   A=0,B=1 → discordant → null（待复核，不得记 0/1）
 *   A=1 → 1；A 异常/无法验证 → null
 * 仅 1 个观察账号时无法复核，0 直接返回。
 */
export async function checkWeiboVisibilityWithObservers(
  observers: Account[],
  mid: string,
  robotCid: string,
  seedIdx: number,
): Promise<{ result: VisibilityResult; accountName: string }> {
  if (observers.length === 0) {
    return { result: { code: null, reason: 'no observer account', queryComplete: false }, accountName: '' };
  }
  const a = observers[seedIdx % observers.length];
  const r1 = await checkWeiboVisibility(a.cookie, mid, robotCid);
  if (r1.code !== 0) return { result: r1, accountName: a.nickname };

  if (observers.length < 2) return { result: r1, accountName: a.nickname };
  const b = observers[(seedIdx + 1) % observers.length];
  const r2 = await checkWeiboVisibility(b.cookie, mid, robotCid);
  if (r2.code === 0) {
    return {
      result: { code: 0, queryComplete: true, reason: 'confirmed by 2 observers' },
      accountName: `${a.nickname}+${b.nickname}`,
    };
  }
  if (r2.code === 1) {
    return {
      result: { code: null, reason: `observer discordance (@${a.nickname}=0 vs @${b.nickname}=1)`, queryComplete: false },
      accountName: `${a.nickname}+${b.nickname}`,
    };
  }
  return {
    result: { code: null, reason: `recheck NA (@${b.nickname}): ${r2.reason || 'unverifiable'}`, queryComplete: false },
    accountName: `${a.nickname}+${b.nickname}`,
  };
}

/**
 * 写入一次可见性检查结果：
 *   - intervention_logs 只落聚合字段（visibility_{point} + 实际检查时间戳 + last/first 时间戳），
 *     不再写公共的 account/method/failure_reason（避免后次检查覆盖前次，规范 P1-5）；
 *   - 每次检查独立落 visibility_checks 表（审计链完整，CSV 导出时 pivot）；
 *   - 曾经判 0 后又判 1 → visibility_inconsistency=1 并撤销 first_verified_invisible_timestamp（规范建议2）；
 *   - 检查晚于目标时间时如实记录 actual_check_timestamp，不伪装准时。
 */
export async function writeVisibility(
  logId: string,
  point: string,
  result: VisibilityResult,
  accountName: string,
  method: string,
  targetTs?: string,
): Promise<void> {
  const tsNow = now();
  const fields: Record<string, unknown> = {
    [`visibility_${point}`]: result.code,
    [`visibility_check_${point}_timestamp`]: tsNow,
  };

  // 读取当前 last/first 时间戳以决定是否更新
  const { rows } = await query<{
    last_verified_visible_timestamp?: string;
    first_verified_invisible_timestamp?: string;
  }>(
    'intervention_logs',
    { id: logId },
    { projection: { last_verified_visible_timestamp: 1, first_verified_invisible_timestamp: 1 } },
  );
  const cur = rows[0] || {};
  if (result.code === 1) {
    fields.last_verified_visible_timestamp = tsNow;
    // 曾经判 0 后又可见：记录不一致并撤销 first（规范建议2，完整 history 形成后再派生）
    if (cur.first_verified_invisible_timestamp) {
      fields.visibility_inconsistency = 1;
      fields.first_verified_invisible_timestamp = null;
    }
  } else if (result.code === 0 && !cur.first_verified_invisible_timestamp) {
    fields.first_verified_invisible_timestamp = tsNow;
  }

  await updateOne('intervention_logs', { id: logId }, fields);

  // 每次检查独立落表（规范 P1-5 方案A：visibility_checks 审计表）
  await insert('visibility_checks', {
    intervention_log_id: logId,
    point,
    target_check_timestamp: targetTs || null,
    actual_check_timestamp: tsNow,
    observer_account_id: accountName,
    result: result.code,
    method,
    failure_reason: result.code === null ? result.reason || 'unverifiable' : null,
    query_complete: result.queryComplete === undefined ? null : result.queryComplete,
  });
}
