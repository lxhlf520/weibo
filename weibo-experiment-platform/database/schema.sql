-- =====================================================
-- 微博AI评论互动实验平台 - 数据库建表脚本
-- 在 Supabase SQL Editor 中执行本脚本
-- =====================================================

-- 1. 实验用户表（多用户隔离核心）
CREATE TABLE IF NOT EXISTS experiment_users (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 2. 微博账号池（每个用户管理自己的微博账号）
CREATE TABLE IF NOT EXISTS weibo_accounts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES experiment_users(id),
  cookie TEXT NOT NULL,
  weibo_uid TEXT,
  nickname TEXT,
  avatar TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'banned', 'error')),
  daily_comment_count INT DEFAULT 0,
  max_daily_comments INT DEFAULT 100,
  last_used_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 3. 实验运行记录
CREATE TABLE IF NOT EXISTS experiment_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES experiment_users(id),
  date DATE NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'screening', 'baseline', 'intervention', 'collecting', 'completed')),
  total_posts INT DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 4. 帖子池（筛选后进入实验的Post）
CREATE TABLE IF NOT EXISTS posts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES experiment_users(id),
  experiment_id BIGINT REFERENCES experiment_runs(id),
  post_id TEXT NOT NULL,
  post_url TEXT,
  content TEXT NOT NULL,
  author_uid TEXT NOT NULL,
  author_name TEXT,
  followers INT,
  comments_count INT DEFAULT 0,
  reposts_count INT DEFAULT 0,
  likes_count INT DEFAULT 0,
  post_group TEXT CHECK (post_group IN ('control', 'low', 'high')),
  pseudo_time TIMESTAMP WITH TIME ZONE,
  published_at TIMESTAMP WITH TIME ZONE,
  screened_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 5. Post快照（t0/t2h/t12h/t24h/t48h/t72h 数据采集）
CREATE TABLE IF NOT EXISTS post_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  time_point TEXT NOT NULL CHECK (time_point IN ('t0', 't2h', 't4h', 't8h', 't12h', 't24h', 't48h', 't72h')),
  comments INT DEFAULT 0,
  reposts INT DEFAULT 0,
  likes INT DEFAULT 0,
  raw_metadata JSONB,
  collected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(post_id, time_point)
);

-- 6. 干预日志
CREATE TABLE IF NOT EXISTS intervention_logs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id BIGINT NOT NULL REFERENCES experiment_runs(id),
  post_id BIGINT NOT NULL REFERENCES posts(id),
  account_id BIGINT REFERENCES weibo_accounts(id),
  post_group TEXT NOT NULL CHECK (post_group IN ('control', 'low', 'high')),
  comment_template TEXT,
  comment_content TEXT,
  weibo_comment_id TEXT,
  sent_at TIMESTAMP WITH TIME ZONE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error_message TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. 评论快照（构建评论树）
CREATE TABLE IF NOT EXISTS comment_snapshots (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  comment_id TEXT NOT NULL,
  parent_comment_id TEXT,
  root_comment_id TEXT,
  content TEXT,
  commenter_uid TEXT,
  commenter_name TEXT,
  comment_time TIMESTAMP WITH TIME ZONE,
  like_count INT DEFAULT 0,
  raw_metadata JSONB,
  collected_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. 结果分析表
CREATE TABLE IF NOT EXISTS outcome_analysis (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  experiment_id BIGINT NOT NULL REFERENCES experiment_runs(id),
  post_id BIGINT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  post_group TEXT CHECK (post_group IN ('control', 'low', 'high')),
  baseline_comments INT DEFAULT 0,
  baseline_reposts INT DEFAULT 0,
  baseline_likes INT DEFAULT 0,
  final_comments INT DEFAULT 0,
  final_reposts INT DEFAULT 0,
  final_likes INT DEFAULT 0,
  delta_comments INT DEFAULT 0,
  delta_reposts INT DEFAULT 0,
  delta_likes INT DEFAULT 0,
  calculated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(experiment_id, post_id)
);

-- 9. 评论模板表
CREATE TABLE IF NOT EXISTS comment_templates (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  post_group TEXT NOT NULL CHECK (post_group IN ('low', 'high')),
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- =====================================================
-- 预置评论模板数据
-- =====================================================
INSERT INTO comment_templates (post_group, content, sort_order) VALUES
  ('low', '路过看到这条。', 1),
  ('low', '刷到这条了。', 2),
  ('high', 'AI生成评论：路过看到这条。', 3),
  ('high', 'AI生成评论：刷到这条了。', 4)
ON CONFLICT DO NOTHING;

-- =====================================================
-- 索引
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_experiment_users_token ON experiment_users(token);
CREATE INDEX IF NOT EXISTS idx_weibo_accounts_user_id ON weibo_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_weibo_accounts_status ON weibo_accounts(status);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_user_id ON experiment_runs(user_id);
CREATE INDEX IF NOT EXISTS idx_experiment_runs_date ON experiment_runs(date);
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_experiment_id ON posts(experiment_id);
CREATE INDEX IF NOT EXISTS idx_posts_post_group ON posts(post_group);
CREATE INDEX IF NOT EXISTS idx_post_snapshots_post_id ON post_snapshots(post_id);
CREATE INDEX IF NOT EXISTS idx_intervention_logs_experiment ON intervention_logs(experiment_id);
CREATE INDEX IF NOT EXISTS idx_intervention_logs_post ON intervention_logs(post_id);
CREATE INDEX IF NOT EXISTS idx_comment_snapshots_post_id ON comment_snapshots(post_id);
CREATE INDEX IF NOT EXISTS idx_comment_snapshots_parent ON comment_snapshots(root_comment_id);
CREATE INDEX IF NOT EXISTS idx_outcome_analysis_experiment ON outcome_analysis(experiment_id);

-- =====================================================
-- RLS 策略已移除（本地 PostgreSQL 由 API 层保证隔离）
-- =====================================================
