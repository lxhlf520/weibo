'use client';

import { useState, useEffect, useCallback } from 'react';

interface StatItem {
  total: number;
  today: number;
}

interface DashboardStats {
  data: StatItem;
  posts: StatItem;
  comments: StatItem;
  users: StatItem;
  generated_at: string;
}

export default function HomePage() {
  // 仪表盘统计数据（数据源：采集库 weibo_supplement）
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [statsError, setStatsError] = useState('');

  const fetchStats = useCallback(async () => {
    setLoading(true);
    setStatsError('');
    try {
      const resp = await fetch('/api/dashboard');
      const d = await resp.json();
      if (d && d.data) {
        setStats(d);
      } else {
        setStatsError(d.error || '统计数据加载失败');
      }
    } catch (e) {
      setStatsError(e instanceof Error ? e.message : '统计数据加载失败');
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  // 数据仪表盘
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">数据仪表盘</h1>
        <button
          onClick={fetchStats}
          disabled={loading}
          className="text-sm px-4 py-1.5 rounded-lg bg-white border border-gray-200 shadow-sm text-gray-600 hover:bg-gray-50 transition disabled:opacity-50"
        >
          {loading ? '刷新中...' : '刷新'}
        </button>
      </div>

      {statsError && (
        <div className="bg-red-50 text-red-600 px-4 py-3 rounded-lg mb-4">{statsError}</div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <DashboardCard title="数据总量" item={stats?.data} color="blue" />
        <DashboardCard title="Post 数" item={stats?.posts} color="green" />
        <DashboardCard title="评论数" item={stats?.comments} color="purple" />
        <DashboardCard title="用户数" item={stats?.users} color="orange" />
      </div>

      <div className="text-xs text-gray-400 leading-5">
        <p>数据口径：数据总量 = 采集库全部文档（帖子清单 + AI曝光帖 + 作者归档 + 采集原始帖 + UID映射）；Post 数 = 帖子清单总量，当日为今日新采集入库帖数；评论数 = AI 曝光帖关联评论合计；用户数 = UID 映射收录用户数。</p>
        <p>
          「当日」为本机时区今日 0 点至今的新增入库数据。
          {stats?.generated_at ? ` 统计时间：${new Date(stats.generated_at).toLocaleString('zh-CN')}` : ''}
        </p>
      </div>
    </div>
  );
}

function DashboardCard({
  title,
  item,
  color,
}: {
  title: string;
  item?: StatItem;
  color: 'blue' | 'green' | 'purple' | 'orange';
}) {
  const colors = {
    blue: 'bg-blue-50 border-blue-200',
    green: 'bg-green-50 border-green-200',
    purple: 'bg-purple-50 border-purple-200',
    orange: 'bg-orange-50 border-orange-200',
  };

  return (
    <div className={`rounded-xl border p-5 ${colors[color]}`}>
      <h3 className="text-sm font-medium text-gray-600">{title}</h3>
      <p className="text-3xl font-bold mt-1 tabular-nums">
        {item ? item.total.toLocaleString() : '—'}
      </p>
      <p className="text-xs text-gray-500 mt-1">总计</p>
      <p className="text-sm mt-3 font-medium text-green-700 tabular-nums">
        当日 +{item ? item.today.toLocaleString() : '—'}
      </p>
    </div>
  );
}
