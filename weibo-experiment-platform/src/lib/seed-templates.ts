/**
 * 评论模板自动同步
 * ============================================================================
 * 调度器启动时运行，确保 MongoDB 中的 comment_templates 与代码定义一致。
 * 使用 upsert（按 post_group + content 去重），不会覆盖已有但会新增缺失。
 */

import { upsert, query } from './db';

interface TemplateRow {
  post_group: string;
  content: string;
  sort_order: number;
  is_active: boolean;
}

/** 默认 80 条评论模板（low 组 40 条 + high 组 40 条，high 组带 "AI生成评论：" 前缀） */
const DEFAULT_TEMPLATES: TemplateRow[] = [
  { post_group: 'low', content: "路过看到这条。", sort_order: 1, is_active: true },
  { post_group: 'low', content: "刷到这条了。", sort_order: 2, is_active: true },
  { post_group: 'low', content: "刚好看到这条。", sort_order: 3, is_active: true },
  { post_group: 'low', content: "看到这条内容了。", sort_order: 4, is_active: true },
  { post_group: 'low', content: "刷到这里看到了。", sort_order: 5, is_active: true },
  { post_group: 'low', content: "正好看到这条。", sort_order: 6, is_active: true },
  { post_group: 'low', content: "刚刚刷到这条。", sort_order: 7, is_active: true },
  { post_group: 'low', content: "刚巧看到这条。", sort_order: 8, is_active: true },
  { post_group: 'low', content: "刷到这里了。", sort_order: 9, is_active: true },
  { post_group: 'low', content: "正好刷到这条。", sort_order: 10, is_active: true },
  { post_group: 'low', content: "刚刷到这一条。", sort_order: 11, is_active: true },
  { post_group: 'low', content: "看到这一条了。", sort_order: 12, is_active: true },
  { post_group: 'low', content: "路过这里看到了。", sort_order: 13, is_active: true },
  { post_group: 'low', content: "刚刚看到这一条。", sort_order: 14, is_active: true },
  { post_group: 'low', content: "正巧刷到这条。", sort_order: 15, is_active: true },
  { post_group: 'low', content: "刚好刷到这一条。", sort_order: 16, is_active: true },
  { post_group: 'low', content: "刷到这一条了。", sort_order: 17, is_active: true },
  { post_group: 'low', content: "这会儿刷到这条了。", sort_order: 18, is_active: true },
  { post_group: 'low', content: "刚好看到这里。", sort_order: 19, is_active: true },
  { post_group: 'low', content: "正好看到这里。", sort_order: 20, is_active: true },
  { post_group: 'low', content: "刷到这条内容了。", sort_order: 21, is_active: true },
  { post_group: 'low', content: "刚刚看到这条内容。", sort_order: 22, is_active: true },
  { post_group: 'low', content: "正好刷到这里。", sort_order: 23, is_active: true },
  { post_group: 'low', content: "刚巧刷到这里。", sort_order: 24, is_active: true },
  { post_group: 'low', content: "碰巧看到这条。", sort_order: 25, is_active: true },
  { post_group: 'low', content: "刚好刷到这条了。", sort_order: 26, is_active: true },
  { post_group: 'low', content: "正好刷到这条了。", sort_order: 27, is_active: true },
  { post_group: 'low', content: "刚刚刷到这里。", sort_order: 28, is_active: true },
  { post_group: 'low', content: "刚巧刷到这一条。", sort_order: 29, is_active: true },
  { post_group: 'low', content: "正好刷到这一条。", sort_order: 30, is_active: true },
  { post_group: 'low', content: "刚看到这一条。", sort_order: 31, is_active: true },
  { post_group: 'low', content: "正好看到这一条。", sort_order: 32, is_active: true },
  { post_group: 'low', content: "刚巧看到这一条。", sort_order: 33, is_active: true },
  { post_group: 'low', content: "路过看到了这条。", sort_order: 34, is_active: true },
  { post_group: 'low', content: "刚好看到了这条。", sort_order: 35, is_active: true },
  { post_group: 'low', content: "正好看到了这条。", sort_order: 36, is_active: true },
  { post_group: 'low', content: "刚刚看到了这条。", sort_order: 37, is_active: true },
  { post_group: 'low', content: "这条刚好刷到了。", sort_order: 38, is_active: true },
  { post_group: 'low', content: "这条正好刷到了。", sort_order: 39, is_active: true },
  { post_group: 'low', content: "这条刚刚看到了。", sort_order: 40, is_active: true },
  { post_group: 'high', content: "AI生成评论：路过看到这条。", sort_order: 41, is_active: true },
  { post_group: 'high', content: "AI生成评论：刷到这条了。", sort_order: 42, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚好看到这条。", sort_order: 43, is_active: true },
  { post_group: 'high', content: "AI生成评论：看到这条内容了。", sort_order: 44, is_active: true },
  { post_group: 'high', content: "AI生成评论：刷到这里看到了。", sort_order: 45, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好看到这条。", sort_order: 46, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刚刷到这条。", sort_order: 47, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚巧看到这条。", sort_order: 48, is_active: true },
  { post_group: 'high', content: "AI生成评论：刷到这里了。", sort_order: 49, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好刷到这条。", sort_order: 50, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刷到这一条。", sort_order: 51, is_active: true },
  { post_group: 'high', content: "AI生成评论：看到这一条了。", sort_order: 52, is_active: true },
  { post_group: 'high', content: "AI生成评论：路过这里看到了。", sort_order: 53, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刚看到这一条。", sort_order: 54, is_active: true },
  { post_group: 'high', content: "AI生成评论：正巧刷到这条。", sort_order: 55, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚好刷到这一条。", sort_order: 56, is_active: true },
  { post_group: 'high', content: "AI生成评论：刷到这一条了。", sort_order: 57, is_active: true },
  { post_group: 'high', content: "AI生成评论：这会儿刷到这条了。", sort_order: 58, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚好看到这里。", sort_order: 59, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好看到这里。", sort_order: 60, is_active: true },
  { post_group: 'high', content: "AI生成评论：刷到这条内容了。", sort_order: 61, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刚看到这条内容。", sort_order: 62, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好刷到这里。", sort_order: 63, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚巧刷到这里。", sort_order: 64, is_active: true },
  { post_group: 'high', content: "AI生成评论：碰巧看到这条。", sort_order: 65, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚好刷到这条了。", sort_order: 66, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好刷到这条了。", sort_order: 67, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刚刷到这里。", sort_order: 68, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚巧刷到这一条。", sort_order: 69, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好刷到这一条。", sort_order: 70, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚看到这一条。", sort_order: 71, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好看到这一条。", sort_order: 72, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚巧看到这一条。", sort_order: 73, is_active: true },
  { post_group: 'high', content: "AI生成评论：路过看到了这条。", sort_order: 74, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚好看到了这条。", sort_order: 75, is_active: true },
  { post_group: 'high', content: "AI生成评论：正好看到了这条。", sort_order: 76, is_active: true },
  { post_group: 'high', content: "AI生成评论：刚刚看到了这条。", sort_order: 77, is_active: true },
  { post_group: 'high', content: "AI生成评论：这条刚好刷到了。", sort_order: 78, is_active: true },
  { post_group: 'high', content: "AI生成评论：这条正好刷到了。", sort_order: 79, is_active: true },
  { post_group: 'high', content: "AI生成评论：这条刚刚看到了。", sort_order: 80, is_active: true },
];

/**
 * 同步默认模板到 comment_templates 集合。
 * 新增缺失模板，已有模板（按 post_group + content 匹配）保持不变。
 */
export async function ensureTemplates(): Promise<{ created: number; existing: number }> {
  let created = 0;
  let existing = 0;

  for (const tpl of DEFAULT_TEMPLATES) {
    // 按 post_group + content 去重
    const { rows } = await query<TemplateRow & { id: string }>(
      'comment_templates',
      { post_group: tpl.post_group, content: tpl.content },
    );

    if (rows.length === 0) {
      await upsert(
        'comment_templates',
        { post_group: tpl.post_group, content: tpl.content },
        {
          post_group: tpl.post_group,
          content: tpl.content,
          sort_order: tpl.sort_order,
          is_active: tpl.is_active,
          created_at: new Date().toISOString(),
        },
      );
      created++;
    } else {
      // 已有模板，确保 is_active 和 sort_order 最新
      await upsert(
        'comment_templates',
        { post_group: tpl.post_group, content: tpl.content },
        {
          sort_order: tpl.sort_order,
          is_active: tpl.is_active,
        },
      );
      existing++;
    }
  }

  // 禁用多余的低质量模板（不在 DEFAULT_TEMPLATES 中的标记为 inactive）
  const { rows: allActive } = await query<TemplateRow & { id: string }>(
    'comment_templates',
    { is_active: true },
  );

  const defaultContents = new Set(DEFAULT_TEMPLATES.map((t) => t.content));
  let disabled = 0;

  for (const row of allActive) {
    if (!defaultContents.has(row.content)) {
      await upsert(
        'comment_templates',
        { id: row.id },
        { is_active: false },
      );
      disabled++;
    }
  }

  if (disabled > 0) {
    console.log(`[模板同步] 已禁用 ${disabled} 条旧模板`);
  }

  return { created, existing };
}
