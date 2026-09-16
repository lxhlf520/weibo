/**
 * 测试入口 - 3账号采集 → 3+3+3 实验 → 评论发送
 * ============================================================================
 * 用法: npx tsx src/jobs/test-entry.ts
 *
 * 流程:
 *   1. 读取前 3 个 active 账号
 *   2. 从 s.weibo.com/realtime 抓取约 1000 条候选帖 mid
 *   3. 逐条 statuses/show 硬性筛选 → 入候选池 candidate_pool
 *   4. 选 9 篇实验帖（3 control + 3 low + 3 high），写 posts + intervention_logs
 *   5. 采集 t0 基线 + 发送评论（low/high 组各 3 条）
 *
 * 相比正式调度系统的差异：
 *   - 不按 16/18/20 分批，一次性跑完采集→选帖→评论全流程
 *   - 仅使用前 3 个账号
 *   - 候选目标 1000 条 mid（实际合格数取决于筛选通过率）
 */

// ── 先设环境变量再动态导入（确保 shared.ts 读到测试参数）────

process.env.CANDIDATE_BATCH = '1000';
process.env.TARGET_QUALIFIED = '9';
process.env.EXPERIMENT_POSTS = '9';
process.env.MAX_PAGES = '5';

async function main() {
  console.log('='.repeat(65));
  console.log('  测试入口 - 3账号 · 1000样本 · 3+3+3实验');
  console.log('  开始时间:', new Date().toLocaleString());
  console.log('='.repeat(65));

  // ── 动态导入（确保 env 已设置）──────────────────────────
  const { getActiveAccounts } = await import('./shared');
  const { query } = await import('../lib/db');
  const { getDb, cn } = await import('../lib/db');

  // 清理当天旧实验（支持重复跑测试）
  const today = new Date().toISOString().split('T')[0];
  const { rows: oldExps } = await query<{ id: string }>('experiment_runs', { experiment_date: today });
  if (oldExps.length > 0) {
    const oldIds = oldExps.map((e) => e.id);
    const { ObjectId } = await import('mongodb');
    const database = await getDb();
    await database.collection(cn('experiment_runs')).deleteMany({ _id: { $in: oldIds.map((id) => new ObjectId(id)) } });
    await database.collection(cn('candidate_pool')).deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection(cn('posts')).deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection(cn('intervention_logs')).deleteMany({ experiment_id: { $in: oldIds } });
    await database.collection(cn('post_snapshots')).deleteMany({ experiment_id: { $in: oldIds } });
    console.log(`  已清理 ${oldIds.length} 个当天旧实验`);
  }

  // 1. 取前 3 个 active 账号
  const allAccounts = await getActiveAccounts();
  if (allAccounts.length < 3) {
    console.log(`❌ 可用账号不足（${allAccounts.length}），至少需要 3 个`);
    console.log('   请在管理界面添加账号并导入 Cookie，确保 status=active');
    process.exit(1);
  }
  const accounts = allAccounts.slice(0, 3);
  console.log(`\n✅ 选定 3 个账号: ${accounts.map((a) => a.nickname).join(', ')}`);

  // 确保评论模板存在（空库首次运行需要）
  const { count, insert } = await import('../lib/db');
  const existingTemplates = await count('comment_templates');
  if (existingTemplates === 0) {
    const defaults = [
      { post_group: 'low', content: '路过看到这条。', is_active: true, sort_order: 1 },
      { post_group: 'low', content: '刷到这条了。', is_active: true, sort_order: 2 },
      { post_group: 'high', content: 'AI生成评论：路过看到这条。', is_active: true, sort_order: 1 },
      { post_group: 'high', content: 'AI生成评论：刷到这条了。', is_active: true, sort_order: 2 },
    ];
    for (const t of defaults) await insert('comment_templates', t);
    console.log(`  已初始化 ${defaults.length} 条默认评论模板`);
  } else {
    console.log(`  评论模板已有 ${existingTemplates} 条`);
  }

  // ── Phase 1: 采集 ───────────────────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 1: 采集候选帖');
  console.log('-'.repeat(65));

  const { runCollectBatch } = await import('./collector');
  const batchResult = await runCollectBatch();

  if (!batchResult) {
    console.log('❌ 采集失败，终止');
    process.exit(1);
  }
  console.log(`\n  采集完成: 池累计 ${batchResult.qualified} 篇合格帖`);

  // ── Phase 2: 选帖建实验 ──────────────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 2: 选帖建实验 (3+3+3)');
  console.log('-'.repeat(65));

  const { finalizeExperiment } = await import('./collector');
  const finalResult = await finalizeExperiment();

  if (!finalResult) {
    console.log('❌ 选帖建实验失败，终止');
    process.exit(1);
  }
  const experimentId = finalResult.experimentId;
  console.log(`\n  实验创建完成: experimentId=${experimentId}`);

  // ── Phase 3: 评论 ────────────────────────────────────────
  console.log('\n' + '-'.repeat(65));
  console.log('  Phase 3: 发送评论 + t0 基线');
  console.log('-'.repeat(65));

  const { runDailyComment } = await import('./commenter');
  const commentResult = await runDailyComment(experimentId);

  if (commentResult) {
    console.log(`\n  评论完成: 成功 ${commentResult.sent} / 失败 ${commentResult.failed}`);
  } else {
    console.log('❌ 评论阶段未执行（可能是账号评论权限不足）');
  }

  // ── 总结 ─────────────────────────────────────────────────
  console.log('\n' + '='.repeat(65));
  console.log('  测试完成!');
  console.log(`  实验ID: ${experimentId}`);
  console.log(`  合格池: ${batchResult.qualified} 篇`);
  console.log(`  实验帖: 9 篇 (control=3, low=3, high=3)`);
  if (commentResult) {
    console.log(`  评论: ${commentResult.sent} 条成功 / ${commentResult.failed} 条失败`);
  }
  console.log('  打开 http://localhost:3000 查看仪表盘');
  console.log('='.repeat(65));

  process.exit(0);
}

main().catch((e) => {
  console.error('测试入口异常:', e);
  process.exit(1);
});
