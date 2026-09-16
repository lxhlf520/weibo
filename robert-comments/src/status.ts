/**
 * 进度统计
 */
import { TARGET_ACTIVE } from './config';
import { getCollection, getCounts } from './db';

export async function printStatus(): Promise<void> {
  // 获取各集合数量
  const db = await (await import('./db')).getDb();
  const passivePosts = await db.collection('raw_posts_passive').countDocuments();
  const activePosts = await db.collection('raw_posts_active').countDocuments();
  const oldPosts = await db.collection('raw_posts').countDocuments();
  const passiveComments = await db.collection('raw_comments_passive').countDocuments();
  const activeComments = await db.collection('raw_comments_active').countDocuments();
  const oldComments = await db.collection('raw_comments').countDocuments();
  const users = await db.collection('raw_users').countDocuments();

  const totalPosts = passivePosts + activePosts + oldPosts;
  const totalComments = passiveComments + activeComments + oldComments;

  console.log('');
  console.log('═'.repeat(50));
  console.log('  微博罗伯特评论采集 - 进度报告');
  console.log('═'.repeat(50));
  console.log('');
  console.log(`  帖子总数:   ${totalPosts} / ${TARGET_ACTIVE}  (${((totalPosts / TARGET_ACTIVE) * 100).toFixed(1)}%)`);
  console.log(`    ├ 被动(新): ${passivePosts}`);
  console.log(`    ├ 主动:     ${activePosts}`);
  console.log(`    └ 被动(旧): ${oldPosts}`);
  console.log('');
  console.log(`  评论页总数: ${totalComments}`);
  console.log(`    ├ 被动(新): ${passiveComments}`);
  console.log(`    ├ 主动:     ${activeComments}`);
  console.log(`    └ 被动(旧): ${oldComments}`);
  console.log('');
  console.log(`  用户:         ${users}`);
  console.log('');

  // 显示最新 5 条帖子 URL
  console.log('─'.repeat(50));
  console.log('  最新帖子:');
  const recentPosts = await db.collection('raw_posts_active')
    .find()
    .sort({ collected_at: -1 })
    .limit(5)
    .toArray();
  
  for (const doc of recentPosts) {
    const uid = doc.raw?.user?.id;
    const mid = doc.mid;
    if (uid && mid) {
      console.log(`    https://weibo.com/${uid}/${mid}`);
    }
  }
  console.log('');
  console.log('═'.repeat(50));
  console.log('');
}
