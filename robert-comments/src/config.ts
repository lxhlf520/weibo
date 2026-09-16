/**
 * 罗伯特评论采集 - 全局配置
 */
import 'dotenv/config';

// ─── 罗伯特身份 ────────────────────────────────────────────
export const ROBERT_UID = '5762999670';

// ─── MongoDB ───────────────────────────────────────────────
export const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/';
export const MONGO_DB = process.env.MONGO_DB || 'robert_comments';

// ─── Cookie 池（多个用 ||| 分隔）──────────────────────────
const raw = process.env.WEIBO_COOKIES || '';
export const COOKIES: string[] = raw.split('|||').map(s => s.trim()).filter(Boolean);

// ─── 采集目标（帖子数）────────────────────────────────────
// 8.1-8.14（14天）目标：各 5000
// 8.1-8.30（30天）目标：各 10000
export const TARGET_ACTIVE = Number(process.env.TARGET_ACTIVE) || 5000;
export const TARGET_PASSIVE = Number(process.env.TARGET_PASSIVE) || 5000;

// ─── 搜索关键词 ───────────────────────────────────────────
// 被动评论核心关键词（扩大范围：更多具体请求）
export const PASSIVE_KEYWORDS = [
  '@罗伯特',
  '罗伯特',
  '罗伯特 评论',
  '罗伯特 回复',
  '罗伯特 帮我',
  '罗伯特 写',
  '罗伯特 画',
  '罗伯特 生成',
  // 具体请求场景
  '罗伯特 帮我写',
  '罗伯特 帮我画',
  '罗伯特 帮我生成',
  '罗伯特 帮我做',
  '罗伯特 帮我起',
  '罗伯特 帮我取',
  '罗伯特 帮我想',
  '罗伯特 帮我编',
  '罗伯特 帮我改',
  '罗伯特 帮我翻译',
  '罗伯特 帮我总结',
  '罗伯特 帮我分析',
  '罗伯特 帮我设计',
  '罗伯特 帮我规划',
  '罗伯特 帮我推荐',
  '罗伯特 帮我建议',
  '罗伯特 帮我看看',
  '罗伯特 帮我检查',
  '罗伯特 帮我润色',
  '罗伯特 帮我扩写',
  '罗伯特 帮我缩写',
  '罗伯特 帮我改写',
  '罗伯特 帮我创作',
  '罗伯特 帮我编故事',
  '罗伯特 帮我写诗',
  '罗伯特 帮我写文案',
  '罗伯特 帮我写代码',
  '罗伯特 帮我写程序',
  '罗伯特 帮我写文章',
  '罗伯特 帮我写作文',
  '罗伯特 帮我写日记',
  '罗伯特 帮我写报告',
  '罗伯特 帮我写总结',
  '罗伯特 帮我写计划',
  '罗伯特 帮我写方案',
  '罗伯特 帮我写简历',
  '罗伯特 帮我写邮件',
  '罗伯特 帮我写信',
  '罗伯特 帮我写祝福语',
  '罗伯特 帮我写情书',
  '罗伯特 帮我写歌词',
  '罗伯特 帮我写小说',
  '罗伯特 帮我写剧本',
  '罗伯特 帮我写文案',
  '罗伯特 帮我写广告',
  '罗伯特 帮我写宣传',
  '罗伯特 帮我写介绍',
  '罗伯特 帮我写描述',
  '罗伯特 帮我写标题',
  '罗伯特 帮我起名字',
  '罗伯特 帮我取名字',
  '罗伯特 帮我起个名',
  '罗伯特 帮我取个名',
  '罗伯特 帮我想名字',
  '罗伯特 帮我想个名',
  '罗伯特 帮我想想',
  '罗伯特 帮我出主意',
  '罗伯特 帮我参谋',
  '罗伯特 帮我参考',
];

// ─── 扩容采集配置（2026-09 扩容轮）────────────────────────
// 探测结论（2024-06-01 单日对照）：
//   全天查询 '罗伯特' 5页仅 38 mid；拆 4×6小时段并集 156 mid（76% 纯新增）
//   → 单日采样受全天查询深度限制，时间细分是最大杠杆
//   热门排序(xsort=hot)为独立结果集；suball=1 含转发有增量
// L1 核心词：24 小时段细分 + 附加通道（最高价值）
export const EXPAND_L1_KEYWORDS = [
  '罗伯特',
  '@罗伯特',
  '罗伯特 帮我',
  '罗伯特 帮我写',
  '罗伯特老师',
];

// L2 新变体词：6 小时段细分（4 段）
export const EXPAND_L2_KEYWORDS = [
  // 称呼变体
  '罗伯特哥哥', '罗伯特大人', '罗伯特大大', '小罗伯特', '罗伯特ai', 'ai罗伯特',
  // 召唤/请求
  '召唤罗伯特', '呼叫罗伯特', '请罗伯特', '求罗伯特', '让罗伯特', '问罗伯特',
  '罗伯特救命', '罗伯特救我', '罗伯特快来', '罗伯特出来',
  // 新句式
  '罗伯特 帮你', '罗伯特 你看', '罗伯特 你觉得', '罗伯特 你说', '罗伯特 你怎么',
  '罗伯特 为什么', '罗伯特 快', '罗伯特 懂', '罗伯特 评', '罗伯特 答',
  // 赞美句式
  '罗伯特太强',
];

// 通用泛生活关键词（扩大覆盖面）
export const SEARCH_KEYWORDS = [
  '日常', '生活', '美食', '旅行', '今天', '最近', '天气', '心情', '工作', '周末',
  '早安', '晚安', '回家', '追剧', '运动', '宠物', '猫咪', '狗狗', '咖啡', '奶茶',
  '电影', '音乐', '读书', '拍照', '风景', '日落', '早餐', '下班', '加班', '健身',
  '开心', '难过', '吐槽', '分享', '记录', '打卡', '休息', '逛街', '购物', '做饭',
  '想家', '思念', '朋友', '聚会', '生日', '感动', '幸福', '快乐', '孤独', '回忆',
  '热搜', '搞笑', '有趣', '可爱', '治愈', '段子', '沙雕', '神仙', '绝了', '分享',
];

// ─── 主动采集配置 ─────────────────────────────────────────
// 主动采集：帖子时间范围过滤（只保存此范围内发布的帖子）
export const ACTIVE_DATE_START = '2026-08-01';
export const ACTIVE_DATE_END = '2026-08-30';

// 高命中类别关键词（测试验证：个人成就6%、旅行美食5%、情感倾诉4%、宠物萌系4%）
export const ACTIVE_HIGH_HIT_KEYWORDS = [
  // 个人成就 (6.0%)
  '上岸', 'offer', '毕业', '升职', '考公', '考研', '入职', '通过',
  // 旅行美食 (5.0%)
  '旅行', '美食', '打卡', '探店', '好吃', '旅游',
  // 情感倾诉 (4.0%)
  '难过', '崩溃', '焦虑', '孤独', '失眠', '累了',
  // 宠物萌系 (4.0%)
  '猫咪', '狗狗', '宠物',
];

// 主动采集：评论数阈值（0=不过滤，检查所有帖子）
export const ACTIVE_MIN_COMMENTS = Number(process.env.ACTIVE_MIN_COMMENTS) || 0;

// 主动采集：并行 worker 数
export const ACTIVE_WORKERS = Number(process.env.ACTIVE_WORKERS) || 5;

// 主动采集：每个帖子最多检查评论页数
export const ACTIVE_MAX_COMMENT_PAGES = 3;

// 主动采集：每个热搜关键词最多搜索页数
export const ACTIVE_HOTSEARCH_MAX_PAGES = 10;

// ─── 速率控制 ─────────────────────────────────────────────
export const POST_INTERVAL_MS = 500;
export const POST_INTERVAL_JITTER = 1000;
export const COMMENT_PAGE_INTERVAL_MS = 300;
export const COMMENT_PAGE_JITTER = 500;
export const RATE_LIMIT_PAUSE_MS = 60_000;

// ─── 重试 ─────────────────────────────────────────────────
export const MAX_RETRIES = 2;
export const RETRY_DELAY_MS = 2000;

// ─── User-Agent ───────────────────────────────────────────
export const PC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ─── 工具函数 ─────────────────────────────────────────────
export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function randomDelay(base: number, jitter: number): Promise<void> {
  return sleep(base + Math.random() * jitter);
}

export function now(): string {
  return new Date().toISOString();
}

export function ts(): string {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}
