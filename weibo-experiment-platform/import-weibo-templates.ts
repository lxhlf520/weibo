/**
 * 微博评论模板本地导入（80 条：low 40 + high 40）
 * 数据源: _weibo_templates_80.json（从 docx 提取）
 * 行为与 ensureTemplates 一致：按 (post_group, content) upsert；不在清单内的旧模板标记 is_active=false
 * 运行: $env:MONGO_URI='mongodb://localhost:27017/'; npx tsx import-weibo-templates.ts
 */
import fs from 'fs';
import path from 'path';
import { query, upsert } from './src/lib/db';

interface Tpl { seq: number; low: string; high: string }
interface TplRow { id?: string; post_group?: string; content?: string }

async function main() {
  const jsonPath = path.join(__dirname, '_weibo_templates_80.json');
  const tpl: Tpl[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  if (tpl.length !== 40) throw new Error(`模板组数 ${tpl.length} != 40，请重新提取 docx`);

  const rows = [
    ...tpl.map((t) => ({ post_group: 'low', content: t.low, sort_order: t.seq })),
    ...tpl.map((t) => ({ post_group: 'high', content: t.high, sort_order: 40 + t.seq })),
  ];

  let created = 0;
  let existing = 0;
  for (const r of rows) {
    const { rows: found } = await query<TplRow>('comment_templates', { post_group: r.post_group, content: r.content });
    const doc = {
      post_group: r.post_group,
      content: r.content,
      sort_order: r.sort_order,
      is_active: true,
      created_at: new Date().toISOString(),
    };
    if (found.length === 0) {
      await upsert('comment_templates', { post_group: r.post_group, content: r.content }, doc);
      created++;
    } else {
      await upsert('comment_templates', { post_group: r.post_group, content: r.content }, {
        sort_order: r.sort_order,
        is_active: true,
      });
      existing++;
    }
  }

  // 禁用不在清单内的旧 active 模板
  const keep = new Set(rows.map((r) => r.content));
  const { rows: allActive } = await query<TplRow>('comment_templates', { is_active: true });
  let disabled = 0;
  for (const row of allActive) {
    if (!row.content || !keep.has(row.content)) {
      await upsert('comment_templates', { id: row.id }, { is_active: false });
      disabled++;
    }
  }

  const { rows: lowCount } = await query<TplRow>('comment_templates', { post_group: 'low', is_active: true });
  const { rows: highCount } = await query<TplRow>('comment_templates', { post_group: 'high', is_active: true });
  console.log(`\n✅ 本地导入完成: 新增 ${created} 条, 已存在 ${existing} 条, 禁用旧模板 ${disabled} 条`);
  console.log(`   active 模板: low=${lowCount.length} high=${highCount.length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
