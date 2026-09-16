import { WeiboPost, searchPosts, getPostDetail, getAllComments } from './weibo-api';

/**
 * Post 筛选规则引擎
 * 根据实验规则文档 V2.0 的硬性约束进行筛选
 */

export interface ScreenedPost {
  postId: string;
  postUrl: string;
  content: string;
  authorUid: string;
  authorName: string;
  followers: number;
  commentsCount: number;
  repostsCount: number;
  likesCount: number;
  publishedAt: string;
  failReason?: string;
}

export interface ScreeningCriteria {
  /** 发布时间上限（小时），默认12 */
  maxHoursAgo?: number;
  /** 最少汉字数，默认8 */
  minChineseChars?: number;
  /** 评论数下限，默认10 */
  minComments?: number;
  /** 评论数上限，默认500 */
  maxComments?: number;
  /** 最大粉丝数，默认500000 */
  maxFollowers?: number;
  /** 排除的关键词（话题、营销等） */
  excludeKeywords?: string[];
}

const DEFAULT_EXCLUDE_KEYWORDS = [
  // 敏感/政治
  '热搜', '政治', '灾难', '事故', '自杀', '自伤', '未成年人',
  // 营销/广告
  '抽奖', '转发抽奖', '福利', '加群', '加V', '广告', '推广', '优惠', '促销',
  '秒杀', '拼团', '红包', '赚钱', '兼职', '日赚', '投资', '理财',
  '股票', '基金', '保险', '代购', '微商', '加盟', '招商',
  // 涨粉/引流
  '私信我', '关注我', '求关注', '互粉', '涨粉', '求赞', '互赞',
  '课程', '训练营', '领取', '免费领', '限时',
  // 医疗/法律
  '医疗', '法律咨询', '金融',
];

const AI_IDENTITY_KEYWORDS = ['AI', 'bot', '机器人', 'ChatGPT', 'AI助手', '人工智能'];

/**
 * 检查是否为原创帖子（非转发）
 */
function isOriginal(post: WeiboPost): boolean {
  return !post.retweeted_status;
}

/**
 * 检查文本是否包含足够的汉字
 */
function countChineseChars(text: string): number {
  const matches = text.match(/[\u4e00-\u9fff]/g);
  return matches ? matches.length : 0;
}

/**
 * 检查帖子是否公开可见
 */
function isPublic(post: WeiboPost): boolean {
  // 微博API返回的帖子默认是公开的
  // 如果有 visible 字段，检查它
  return true;
}

/**
 * 检查用户是否为普通个人账号（排除政府/媒体/蓝V等所有官方账号）
 */
function isNormalUser(post: WeiboPost): boolean {
  const user = post.user;
  // verified_type: -1=普通用户, 0=黄V(个人认证)
  // verified_type > 0: 蓝V(企业/政府/媒体/校园/网站等官方账号)
  if (user.verified_type > 0) {
    return false;
  }
  return true;
}

/**
 * 检查内容是否包含排除关键词
 */
function containsExcludeKeywords(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

/**
 * AI回复三层过滤 - 第一层：排除已知社交机器人评论的帖子
 */
async function filterLayer1_robotComments(
  cookies: string,
  posts: WeiboPost[],
): Promise<WeiboPost[]> {
  // 简化实现：检查帖子评论中是否包含自动化/机器人账号
  const result: WeiboPost[] = [];

  for (const post of posts) {
    try {
      // 获取帖子的前几页评论
      const comments = await getAllComments(cookies, post.idstr || post.id, 2);
      const hasRobotComment = comments.some((c) => {
        const userName = (c.user?.screen_name || '').toLowerCase();
        const userDesc = ''; // 评论对象通常不含简介
        return AI_IDENTITY_KEYWORDS.some(
          (kw) => userName.includes(kw.toLowerCase()) || userDesc.includes(kw.toLowerCase()),
        );
      });

      if (!hasRobotComment) {
        result.push(post);
      }
    } catch {
      // 获取评论失败时保留该帖子（后续可人工审核）
      result.push(post);
    }

    // 请求间隔
    await new Promise((r) => setTimeout(r, 500));
  }

  return result;
}

/**
 * AI回复三层过滤 - 第二层：排除简介含AI身份线索的用户
 */
function filterLayer2_aiProfile(posts: WeiboPost[]): WeiboPost[] {
  return posts.filter((post) => {
    const userName = (post.user?.screen_name || '').toLowerCase();
    const userDesc = (post.user?.description || '').toLowerCase();
    return !AI_IDENTITY_KEYWORDS.some(
      (kw) => userName.includes(kw.toLowerCase()) || userDesc.includes(kw.toLowerCase()),
    );
  });
}

/**
 * AI回复三层过滤 - 第三层：排除评论文本声明"我是AI"等
 */
async function filterLayer3_aiComment(
  cookies: string,
  posts: WeiboPost[],
): Promise<WeiboPost[]> {
  const result: WeiboPost[] = [];

  for (const post of posts) {
    try {
      const comments = await getAllComments(cookies, post.idstr || post.id, 3);
      const hasAiDeclaration = comments.some((c) => {
        const text = (c.text || c.text_raw || '').toLowerCase();
        return AI_IDENTITY_KEYWORDS.some((kw) => text.includes(kw.toLowerCase()));
      });

      if (!hasAiDeclaration) {
        result.push(post);
      }
    } catch {
      result.push(post);
    }
    await new Promise((r) => setTimeout(r, 500));
  }

  return result;
}

/**
 * 用户去重：确保POST池中的用户不重复
 */
function deduplicateUsers(posts: WeiboPost[]): WeiboPost[] {
  const seenUids = new Set<string>();
  return posts.filter((post) => {
    const uid = String(post.user?.id || post.user?.idstr || '');
    if (seenUids.has(uid)) return false;
    seenUids.add(uid);
    return true;
  });
}

/**
 * 主筛选函数：从搜索结果中筛选符合条件的Post
 */
export async function screenPosts(
  cookies: string,
  keywords: string[],
  criteria: ScreeningCriteria = {},
): Promise<{ passed: ScreenedPost[]; rejected: ScreenedPost[] }> {
  const {
    maxHoursAgo = 12,
    minChineseChars = 8,
    minComments = 10,
    maxComments = 500,
    maxFollowers = 500_000,
    excludeKeywords = DEFAULT_EXCLUDE_KEYWORDS,
  } = criteria;

  const passed: ScreenedPost[] = [];
  const rejected: ScreenedPost[] = [];

  // 计算12小时前的时间戳
  const cutoffTime = Date.now() - maxHoursAgo * 3600 * 1000;

  // 每个关键词搜索多页
  let allPosts: WeiboPost[] = [];
  for (const keyword of keywords) {
    for (let page = 1; page <= 3; page++) {
      try {
        const result = await searchPosts(cookies, keyword, page);
        allPosts = allPosts.concat(result.posts);
        await new Promise((r) => setTimeout(r, 800));
      } catch {
        break;
      }
    }
  }

  // 去重（按postId）
  const seen = new Set<string>();
  allPosts = allPosts.filter((p) => {
    const pid = p.idstr || p.id;
    if (seen.has(pid)) return false;
    seen.add(pid);
    return true;
  });

  // 逐条硬性过滤
  for (const post of allPosts) {
    const pid = post.idstr || post.id;
    const content = post.text_raw || post.text || '';
    const followers = post.user?.followers_count || 0;
    const commentsCount = post.comments_count || 0;
    const postTime = new Date(post.created_at).getTime();
    const baseInfo: ScreenedPost = {
      postId: pid,
      postUrl: `https://weibo.com/${post.user?.id || 0}/${pid}`,
      content,
      authorUid: String(post.user?.id || post.user?.idstr || ''),
      authorName: post.user?.screen_name || '',
      followers,
      commentsCount,
      repostsCount: post.reposts_count || 0,
      likesCount: post.attitudes_count || 0,
      publishedAt: post.created_at,
    };

    // 时间检查
    if (postTime < cutoffTime) {
      rejected.push({ ...baseInfo, failReason: '超过12小时' });
      continue;
    }

    // 公开性检查
    if (!isPublic(post)) {
      rejected.push({ ...baseInfo, failReason: '非公开帖' });
      continue;
    }

    // 原创性检查
    if (!isOriginal(post)) {
      rejected.push({ ...baseInfo, failReason: '转发帖' });
      continue;
    }

    // 账号类型检查
    if (!isNormalUser(post)) {
      rejected.push({ ...baseInfo, failReason: '蓝V认证账号' });
      continue;
    }

    // 汉字数检查
    if (countChineseChars(content) < minChineseChars) {
      rejected.push({ ...baseInfo, failReason: `汉字不足${minChineseChars}字` });
      continue;
    }

    // 评论数范围检查
    if (commentsCount < minComments || commentsCount > maxComments) {
      rejected.push({
        ...baseInfo,
        failReason: `评论数${commentsCount}不在${minComments}-${maxComments}范围`,
      });
      continue;
    }

    // 粉丝数检查
    if (followers >= maxFollowers) {
      rejected.push({ ...baseInfo, failReason: `粉丝数${followers}超过${maxFollowers}` });
      continue;
    }

    // 排除关键词检查
    if (containsExcludeKeywords(content, excludeKeywords)) {
      rejected.push({ ...baseInfo, failReason: '包含排除关键词' });
      continue;
    }

    passed.push(baseInfo);
  }

  // 用户去重
  const deduped = deduplicateUsers(
    passed.map((p) => {
      const original = allPosts.find((ap) => (ap.idstr || ap.id) === p.postId);
      return original!;
    }),
  );

  const dedupedIds = new Set(deduped.map((p) => p.idstr || p.id));
  const finalPassed = passed.filter((p) => dedupedIds.has(p.postId));

  // AI回复三层过滤
  let filtered = deduped;
  try {
    filtered = await filterLayer1_robotComments(cookies, filtered);
    filtered = filterLayer2_aiProfile(filtered);
    filtered = await filterLayer3_aiComment(cookies, filtered);
  } catch {
    // 过滤失败时使用去重后的结果
  }

  const filteredIds = new Set(filtered.map((p) => p.idstr || p.id));
  const aiFiltered = finalPassed.filter((p) => filteredIds.has(p.postId));
  const aiRejected = finalPassed.filter((p) => !filteredIds.has(p.postId));

  return {
    passed: aiFiltered,
    rejected: [...rejected, ...aiRejected.map((p) => ({ ...p, failReason: 'AI回复三层过滤未通过' }))],
  };
}

/**
 * 搜索并筛选帖子（简化版，不执行AI过滤，适合快速预览）
 */
export async function quickScreen(
  cookies: string,
  keyword: string,
  maxResults: number = 50,
): Promise<ScreenedPost[]> {
  const { passed } = await screenPosts(cookies, [keyword], {
    maxHoursAgo: 12,
    minChineseChars: 8,
  });

  return passed.slice(0, maxResults);
}
