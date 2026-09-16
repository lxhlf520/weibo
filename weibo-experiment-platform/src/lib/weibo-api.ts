/**
 * 微博数据采集与评论API
 * 基于 weibo.com/ajax/ 接口，需要有效的PC端Cookie
 */

const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

import { apiLog } from './logger';

export interface WeiboPost {
  id: string;
  idstr: string;
  created_at: string;
  text_raw: string;
  text: string;
  user: {
    id: number;
    idstr: string;
    screen_name: string;
    description?: string;
    followers_count: number;
    verified: boolean;
    verified_type: number;
    avatar_hd: string;
  };
  retweeted_status?: unknown;
  reposts_count: number;
  comments_count: number;
  attitudes_count: number;
  isLongText: boolean;
}

export interface WeiboComment {
  id: number;
  idstr: string;
  created_at: string;
  text: string;
  text_raw: string;
  user: {
    id: number;
    idstr: string;
    screen_name: string;
    avatar_hd: string;
  };
  like_counts: number;
  total_number?: number;
  more_c?: number;  // 更多子回复数，>0 表示还有未展开的回复
  comments?: WeiboComment[];  // is_mix=1 时内嵌的少量子回复
  reply_comment?: {
    id: string;
    text: string;
  };
  rootid?: string;
  rootidstr?: string;
  max_id?: string;  // 子回复翻页 token（fetch_level=1 时返回）
}

/**
 * 从Cookie中提取XSRF-TOKEN
 */
function getXsrfToken(cookies: string): string {
  const match = cookies.match(/XSRF-TOKEN=([^;]+)/);
  return match ? match[1] : '';
}

/**
 * 通用请求头
 */
function headers(cookies: string): Record<string, string> {
  const xsrf = getXsrfToken(cookies);
  return {
    'User-Agent': PC_UA,
    'Cookie': cookies,
    'X-XSRF-TOKEN': xsrf,
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': 'https://weibo.com/',
    'Accept': 'application/json, text/plain, */*',
  };
}

/**
 * 搜索微博帖子
 * 使用微博搜索接口
 */
export async function searchPosts(
  cookies: string,
  keyword: string,
  page: number = 1,
): Promise<{ posts: WeiboPost[]; total: number }> {
  const params = new URLSearchParams({
    q: keyword,
    page: String(page),
  });

  const resp = await fetch(`https://weibo.com/ajax/side/search?${params.toString()}`, {
    headers: {
      ...headers(cookies),
      Referer: 'https://s.weibo.com/',
    },
  });

  if (!resp.ok) {
    apiLog.error(`searchPosts HTTP ${resp.status} keyword="${keyword}" page=${page}`);
    return { posts: [], total: 0 };
  }

  const data = await resp.json();

  // API 返回 data.users[]，每个 user 的 status 字段是最近的帖子
  const users = data?.data?.users || [];
  const posts: WeiboPost[] = [];

  for (const user of users) {
    if (user.status) {
      // 把用户信息合并到 post 里
      const post = user.status;
      if (!post.user) {
        post.user = {
          id: user.id,
          idstr: user.idstr,
          screen_name: user.screen_name,
          followers_count: user.followers_count || 0,
          verified: user.verified || false,
          verified_type: user.verified_type || 0,
          avatar_hd: user.avatar_hd || user.profile_image_url || '',
        };
      }
      posts.push(post);
    }
  }

  return { posts, total: posts.length };
}

/**
 * 获取微博帖子详情
 */
export async function getPostDetail(cookies: string, postId: string): Promise<WeiboPost | null> {
  const resp = await fetch(`https://weibo.com/ajax/statuses/extend?id=${postId}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  return data?.data || data || null;
}

/**
 * 获取帖子详情（同时获取转赞评数据）
 */
export async function getPostMetrics(
  cookies: string,
  postId: string,
): Promise<{ comments: number; reposts: number; likes: number } | null> {
  const resp = await fetch(`https://weibo.com/ajax/statuses/show?id=${postId}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  if (!data) return null;

  return {
    comments: data.comments_count || 0,
    reposts: data.reposts_count || 0,
    likes: data.attitudes_count || 0,
  };
}

/**
 * 获取帖子评论列表
 */
export async function getComments(
  cookies: string,
  postId: string,
  page: number = 1,
  maxId?: string,
): Promise<{ comments: WeiboComment[]; max_id: string | null; total: number }> {
  const params = new URLSearchParams({
    id: postId,
    is_show_bulletin: '2',
    is_mix: '1',
    count: '50',
    fetch_level: '0',
  });
  if (maxId) params.set('max_id', maxId);

  const resp = await fetch(
    `https://weibo.com/ajax/statuses/buildComments?${params.toString()}`,
    { headers: headers(cookies) },
  );

  if (!resp.ok) {
    apiLog.error(`getComments HTTP ${resp.status} postId=${postId}`);
    return { comments: [], max_id: null, total: 0 };
  }

  const data = await resp.json();
  const comments: WeiboComment[] = data?.data || [];
  const max_id = data?.max_id || null;
  const total = data?.total_number || 0;

  return { comments, max_id, total };
}

/**
 * 获取某条评论的全部子回复（翻页）
 * fetch_level=1 + id=评论ID（非帖子ID）+ max_id 翻页
 * uid 为帖子作者的 UID，子回复翻页需要此参数
 */
export async function getCommentReplies(
  cookies: string,
  commentId: string,
  postUid: string,
  maxPages: number = 10,
): Promise<WeiboComment[]> {
  const allReplies: WeiboComment[] = [];
  let maxId: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const params = new URLSearchParams({
      flow: '0',
      is_reload: '1',
      id: commentId,
      is_show_bulletin: '2',
      is_mix: '1',
      fetch_level: '1',
      count: '20',
      uid: postUid,
      locale: 'zh-CN',
    });
    if (maxId) params.set('max_id', maxId);

    const resp = await fetch(
      `https://weibo.com/ajax/statuses/buildComments?${params.toString()}`,
      { headers: headers(cookies) },
    );

    if (!resp.ok) {
      apiLog.error(`getCommentReplies HTTP ${resp.status} commentId=${commentId}`);
      break;
    }

    const data = await resp.json();
    const replies: WeiboComment[] = data?.data || [];
    allReplies.push(...replies);

    if (!data?.max_id) break;
    maxId = data.max_id;
    page++;
  }

  return allReplies;
}

/**
 * 获取全部评论（自动翻页）
 */
export async function getAllComments(
  cookies: string,
  postId: string,
  maxPages: number = 30,
): Promise<WeiboComment[]> {
  const allComments: WeiboComment[] = [];
  let maxId: string | undefined;
  let page = 0;

  while (page < maxPages) {
    const result = await getComments(cookies, postId, page + 1, maxId);
    allComments.push(...result.comments);

    if (!result.max_id) break;
    maxId = result.max_id;
    page++;
  }

  return allComments;
}

/**
 * 获取帖子全部评论及每条评论的完整回复链
 * 返回扁平列表，每条记录的 parent_comment_id 已正确设置
 */
export interface CommentWithParent {
  comment: WeiboComment;
  parent_comment_id: string | null;  // null=顶层评论, 非null=回复某条评论
  root_comment_id: string;           // 顶层评论的 idstr
}

/**
 * 递归收集某条评论的全部子回复（含孙回复）
 * 先调用 fetch_level=1 翻页拉直接子回复，再对每条 more_c>0 的子回复递归
 */
async function collectAllDescendants(
  cookies: string,
  commentId: string,
  postUid: string,
  maxReplyPages: number,
  maxDepth: number,
  currentDepth: number,
  rootCommentId: string,
  seenIds: Set<string>,
): Promise<CommentWithParent[]> {
  if (currentDepth >= maxDepth) return [];

  const result: CommentWithParent[] = [];
  const directReplies = await getCommentReplies(cookies, commentId, postUid, maxReplyPages);

  for (const reply of directReplies) {
    if (seenIds.has(reply.idstr)) continue;
    seenIds.add(reply.idstr);

    const parentId = String(reply.reply_comment?.id || commentId);
    result.push({
      comment: reply,
      parent_comment_id: parentId,
      root_comment_id: rootCommentId,
    });

    // 递归：如果这条回复还有子回复（more_c > 0），继续下拉
    if (reply.more_c && reply.more_c > 0) {
      const grandchildren = await collectAllDescendants(
        cookies, reply.idstr, postUid, maxReplyPages, maxDepth, currentDepth + 1, rootCommentId, seenIds,
      );
      result.push(...grandchildren);
    }
  }

  return result;
}

export async function getAllCommentsWithReplies(
  cookies: string,
  postId: string,
  postUid?: string,
  maxPages: number = 30,
  maxReplyPages: number = 10,
  maxReplyDepth: number = 5,
): Promise<{
  all: CommentWithParent[];
  topLevelCount: number;
  replyCount: number;
}> {
  const result: CommentWithParent[] = [];
  const seenIds = new Set<string>();

  // 翻页拉取全部顶层评论（is_mix=1 会自动带少量内嵌回复在 c.comments 中）
  const topLevelComments = await getAllComments(cookies, postId, maxPages);

  for (const c of topLevelComments) {
    // 顶层评论本身
    seenIds.add(c.idstr);
    result.push({
      comment: c,
      parent_comment_id: null,
      root_comment_id: c.idstr,
    });

    // 收集内嵌子回复
    if (c.comments && c.comments.length > 0) {
      for (const sub of c.comments) {
        if (seenIds.has(sub.idstr)) continue;
        seenIds.add(sub.idstr);
        result.push({
          comment: sub,
          parent_comment_id: String(sub.reply_comment?.id || c.idstr),
          root_comment_id: c.idstr,
        });
      }
    }

    // 翻页拉全部后代（more_c 不可靠，直接拉；递归处理嵌套回复）
    // 注意：内嵌回复和翻页拉回的回复可能有重叠，用 seenIds 去重
    const descendants = await collectAllDescendants(
      cookies, c.idstr, postUid || '', maxReplyPages, maxReplyDepth, 0, c.idstr, seenIds,
    );
    result.push(...descendants);
  }

  const replyCount = result.filter((r) => r.parent_comment_id !== null).length;

  return {
    all: result,
    topLevelCount: topLevelComments.length,
    replyCount,
  };
}

/**
 * 发表一级评论
 * @returns { success: boolean, commentId?: string }
 */
export async function postComment(
  cookies: string,
  postId: string,
  content: string,
): Promise<{ success: boolean; commentId?: string; error?: string }> {
  try {
    const xsrf = getXsrfToken(cookies);
    const formData = new URLSearchParams();
    formData.append('id', postId);
    formData.append('comment', content);
    formData.append('mid', postId);
    formData.append('st', xsrf);

    const resp = await fetch('https://weibo.com/ajax/comments/create', {
      method: 'POST',
      headers: {
        ...headers(cookies),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const data = await resp.json();

    if (data.ok === 1 && data.data) {
      return {
        success: true,
        commentId: data.data.idstr || data.data.comment?.idstr || String(data.data.id),
      };
    }

    const errMsg = data.msg || data.error || `评论发送失败 (retcode: ${data.ok})`;
    return { success: false, error: errMsg };
  } catch (err) {
    apiLog.error(`postComment 网络错误 postId=${postId}`, err);
    return { success: false, error: `网络错误: ${String(err)}` };
  }
}

/**
 * 获取用户信息
 */
export async function getUserProfile(
  cookies: string,
  uid: string,
): Promise<{ nickname: string; avatar: string; followers: number } | null> {
  const resp = await fetch(`https://weibo.com/ajax/profile/info?uid=${uid}`, {
    headers: headers(cookies),
  });

  if (!resp.ok) return null;

  const data = await resp.json();
  if (data.ok !== 1 || !data.data?.user) return null;

  const user = data.data.user;
  return {
    nickname: user.screen_name || '',
    avatar: user.avatar_hd || user.profile_image_url || '',
    followers: user.followers_count || 0,
  };
}

/**
 * 获取博主微博列表
 */
export async function getUserPosts(
  cookies: string,
  uid: string,
  page: number = 1,
): Promise<WeiboPost[]> {
  const resp = await fetch(
    `https://weibo.com/ajax/statuses/mymblog?uid=${uid}&page=${page}&feature=0`,
    { headers: headers(cookies) },
  );

  if (!resp.ok) return [];

  const data = await resp.json();
  return data?.data?.list || data?.data || [];
}

/**
 * 批量获取帖子指标（用于定时数据采集）
 */
export async function batchGetPostMetrics(
  cookies: string,
  postIds: string[],
): Promise<Map<string, { comments: number; reposts: number; likes: number }>> {
  const result = new Map<string, { comments: number; reposts: number; likes: number }>();

  // 逐个请求，避免触发风控
  for (const postId of postIds) {
    try {
      const metrics = await getPostMetrics(cookies, postId);
      if (metrics) {
        result.set(postId, metrics);
      }
      // 请求间隔
      await sleep(500 + Math.random() * 1000);
    } catch {
      // 单个失败不影响整体
    }
  }

  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
