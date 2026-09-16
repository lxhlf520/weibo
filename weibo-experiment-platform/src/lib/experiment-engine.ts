import { ScreenedPost } from './post-screener';
import { query, maybeOne } from './db';

export type ExperimentGroup = 'control' | 'low' | 'high';

export interface GroupedPost {
  post: ScreenedPost;
  group: ExperimentGroup;
  commentContent: string;
  pseudoTime?: string;
  templateId?: string;
}

export interface ExperimentConfig {
  totalPosts: number;
  controlCount: number;
  lowCount: number;
  highCount: number;
}

export interface CommentTemplate { id: string; content: string; post_group: string; is_active: boolean; sort_order: number; }

export function randomizeAndGroup(
  posts: ScreenedPost[],
  targetCount: number = 90,
): { grouped: GroupedPost[]; config: ExperimentConfig } {
  const shuffled = [...posts].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(targetCount, shuffled.length));
  const controlCount = Math.floor(selected.length / 3);
  const lowCount = controlCount;
  const highCount = selected.length - controlCount - lowCount;

  const grouped: GroupedPost[] = [];
  for (let i = 0; i < controlCount; i++) {
    grouped.push({ post: selected[i], group: 'control', commentContent: '', pseudoTime: generatePseudoTime() });
  }
  for (let i = controlCount; i < controlCount + lowCount; i++) {
    grouped.push({ post: selected[i], group: 'low', commentContent: '' });
  }
  for (let i = controlCount + lowCount; i < selected.length; i++) {
    grouped.push({ post: selected[i], group: 'high', commentContent: '' });
  }
  return { grouped, config: { totalPosts: selected.length, controlCount, lowCount, highCount } };
}

function generatePseudoTime(): string {
  const windowStart = 20 * 60;
  const windowEnd = 22 * 60;
  const randomMinutes = windowStart + Math.floor(Math.random() * (windowEnd - windowStart));
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
    Math.floor(randomMinutes / 60), randomMinutes % 60).toISOString();
}

export async function assignTemplates(grouped: GroupedPost[]): Promise<GroupedPost[]> {
  const { rows: lowTemplates } = await query<CommentTemplate>(`comment_templates`, { post_group: 'low', is_active: true });
  const { rows: highTemplates } = await query<CommentTemplate>(`comment_templates`, { post_group: 'high', is_active: true });

  return grouped.map((item) => {
    if (item.group === 'control') return item;
    const templates = item.group === 'low' ? lowTemplates : highTemplates;
    if (templates.length === 0) return item;
    const tmpl = templates[Math.floor(Math.random() * templates.length)];
    return { ...item, commentContent: tmpl.content, templateId: tmpl.id };
  });
}
