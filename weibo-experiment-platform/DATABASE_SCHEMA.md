# 微博实验平台 - MongoDB 数据字典

> **数据库**: `weibo_experiment` | **连接**: `mongodb://localhost:27017/`
> 
> 集合前缀 `weibo_` 由 `src/lib/db.ts` 的 `cn()` 函数自动添加。部分早期集合（`posts`、`experiment_users`、`experiment_runs`、`intervention_logs`、`post_snapshots`、`comment_templates`）无此前缀，属跨平台共用。

---

## 一、账号与用户层

### `weibo_accounts` — 微博账号

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `user_id` | ObjectId | ✅ | 关联 `experiment_users._id` |
| `cookie` | string | ✅ | 完整 Cookie 字符串（含 X-CSRF-TOKEN、SCF、SUB 等） |
| `weibo_uid` | string | ✅ | 微博用户 UID |
| `nickname` | string | ✅ | 微博昵称 |
| `avatar` | string | | 头像图片 URL |
| `status` | string | ✅ | `active` \| `inactive` \| `banned` |
| `daily_comment_count` | number | ✅ | 当日已发评论数（每日 0 点重置） |
| `can_comment` | boolean | ✅ | 是否有评论权限（风控禁评 → `false`） |
| `comment_ban_reason` | string\|null | | 禁评原因，null = 无限制 |
| `comment_checked_at` | string | | 评论权限最后检查时间 (ISO 8601) |

**示例**:
```json
{
  "nickname": "互动研究AI助手-小六子",
  "weibo_uid": "5705908703",
  "status": "active",
  "daily_comment_count": 0,
  "can_comment": true,
  "comment_ban_reason": null
}
```

### `experiment_users` — 实验平台登录用户

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `token` | string | ✅ | 用户认证 Token |
| `name` | string | ✅ | 用户名 |

---

## 二、实验运行层

### `experiment_runs` — 实验运行记录

每场实验创建一条记录，生命周期：`screening → ready → running → completed`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `user_id` | ObjectId | ✅ | 关联 `experiment_users._id` |
| `date` | string | ✅ | 实验创建日期 (`YYYY-MM-DD`) |
| `experiment_date` | string | ✅ | 实验执行日期 (`YYYY-MM-DD`) |
| `status` | string | ✅ | `screening` → `ready` → `running` → `completed` |
| `total_posts` | number | ✅ | 参与实验的帖子总数（目标 90） |
| `t0_at` | string | | t0 基线快照采集时间 |
| `completed_points` | string[] | | 已完成监控的时间点，如 `["t2h","t4h","t8h"]` |
| `created_at` | string | ✅ | 实验创建时间 |

**可用时间点**: `t0`, `t2h`, `t4h`, `t8h`, `t12h`, `t24h`, `t48h`, `t72h`

### `intervention_logs` — 评论干预日志

记录每条 AI 评论的发送状态。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | ObjectId | ✅ | 关联 `experiment_runs._id` |
| `post_id` | ObjectId | ✅ | 关联 `posts._id` |
| `post_group` | string | ✅ | 干预分组：`control` \| `low` \| `high` |
| `comment_template` | ObjectId | ✅ | 关联 `comment_templates._id` |
| `comment_content` | string | ✅ | 实际发送的评论内容 |
| `status` | string | ✅ | `pending` → `sent` → `failed` |
| `comment_id` | string | | 微博评论 ID（发送成功后写入） |
| `sent_at` | string | | 评论发送时间 |
| `account_nickname` | string | | 实际发出评论的账号昵称（sent 时写入） |
| `account_uid` | string | | 实际发出评论的微博 UID（sent 时写入） |
| `error` | string | | 失败原因（仅 status = failed） |

**注意**: `account_nickname` 和 `account_uid` 仅在 `status=sent` 时有值，通过追踪哪个账号成功发出了评论。

---

## 三、帖子与模板层

### `posts` — 实验帖子

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `user_id` | ObjectId | ✅ | 关联 `experiment_users._id` |
| `experiment_id` | ObjectId | ✅ | 关联 `experiment_runs._id` |
| `mid` | string | ✅ | 微博帖子 mid（主键级唯一标识） |
| `post_url` | string | ✅ | 帖子完整 URL，格式 `https://weibo.com/{uid}/{mid}` |
| `content` | string | ✅ | 帖子正文 |
| `author_uid` | string | ✅ | 作者微博 UID |
| `author_name` | string | ✅ | 作者昵称 |
| `followers` | number | | 作者粉丝数 |
| `comments_count` | number | | 评论数（入池时） |
| `reposts_count` | number | | 转发数（入池时） |
| `likes_count` | number | | 点赞数（入池时） |
| `post_group` | string\|null | | 干预分组，null = 尚未分配 |
| `is_spare` | boolean | ✅ | `true` = 备选帖（不在实验 90 帖内） |
| `published_at` | string | ✅ | 帖子发布时间 |

### `comment_templates` — 评论模板

low 组 4 条 + high 组 4 条（high 组内容前带 "AI生成评论：" 前缀）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `post_group` | string | ✅ | 适用分组：`low` \| `high` |
| `content` | string | ✅ | 评论内容 |
| `is_active` | boolean | ✅ | 是否启用 |
| `sort_order` | number | | 排序权重 |
| `created_at` | string | ✅ | 创建时间 |

---

## 四、溯源与快照层（实验核心数据）

> **数据流**: `weibo_post_detail` + `weibo_post_comment_meta` + `weibo_post_user_meta`（3 张原始溯源表）→ `weibo_comment_snapshots` + `weibo_post_snapshots`（2 张结果表）

### `weibo_post_detail` — 帖子详情原始溯源

存储微博 `/ajax/statuses/show` 接口的完整 JSON 响应，一条帖子一行，不丢失任何字段。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | 帖子 mid（唯一键，配合 experiment_id） |
| `mid` | string | ✅ | 帖子 mid（冗余，方便不带实验 ID 的查询） |
| `post_url` | string | ✅ | 帖子完整 URL，方便快速打开原帖 |
| `raw_response` | string | ✅ | `statuses/show` API 完整 JSON 响应（25KB+） |
| `captured_at` | string | ✅ | 采集时间 (ISO 8601) |
| `created_at` | string | ✅ | 写入时间 (ISO 8601) |

**写入时机**: analyzer.ts 采集评论数据时，每个帖子调用 `fetchStatusRaw` 后 upsert。

### `weibo_post_comment_meta` — 评论原始溯源

存储 `getAllComments` 返回的全部评论数组完整 JSON，一帖一行。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | 帖子 mid（唯一键） |
| `mid` | string | ✅ | 帖子 mid（冗余） |
| `post_url` | string | ✅ | 帖子完整 URL，方便快速打开原帖 |
| `raw_response` | string | ✅ | 评论数组完整 JSON（24KB+） |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**写入时机**: analyzer.ts 调用 `getAllComments` 获取全部评论后，将原始数组 JSON.stringify 写入。

**原始 JSON 结构** (raw_response 内每条评论):
```json
{
  "idstr": "5314287851798567",
  "created_at": "Sat Jun 27 05:13:40 +0800 2026",
  "text_raw": "评论内容",
  "like_counts": 0,
  "rootidstr": "5314273995915773",
  "user": { "idstr": "1728860841", "screen_name": "微博同城" },
  "reply_comment": { "id": "xxx" }
}
```

### `weibo_post_user_meta` — 评论用户原始溯源

存储 `getUserProfile` 接口返回的完整 JSON，一个去重用户一行。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `user_id` | string | ✅ | 微博用户 UID（去重唯一键） |
| `raw_response` | string | ✅ | 用户信息 API 完整 JSON 响应（200B+） |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**写入时机**: 遍历评论时，对每个未见过（去重）的评论者调用 `getUserProfile` 后写入。

### `weibo_comment_snapshots` — 结构化评论快照（结果表）

从 `post_comment_meta.raw_response` 提取的结构化评论，一条评论一行，支持构建评论树。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | 帖子 mid |
| `mid` | string | ✅ | 帖子 mid（冗余） |
| `comment_id` | string | ✅ | 微博评论 ID（唯一键） |
| `parent_comment_id` | string\|null | | 父评论 ID，null = 直接评论帖子，非 null = 回复某条评论 |
| `author_uid` | string | ✅ | 评论者微博 UID |
| `author_name` | string | ✅ | 评论者昵称 |
| `content` | string | ✅ | 评论正文 |
| `likes_count` | number | | 评论点赞数 |
| `comment_time` | string | | 评论发布时间 |
| `captured_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

**评论树构建逻辑** (来自 `analyzer.ts` 的 `getParentCommentId`):
- `reply_comment.id` 存在 → `parent_comment_id = reply_comment.id`
- `rootidstr ≠ idstr` → `parent_comment_id = rootidstr`
- 否则 → `parent_comment_id = null`（直接评论帖子）

### `weibo_post_snapshots` — 帖子指标快照（结果表）

记录帖子在不同时间点的关键指标，支持时间序列对比分析。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `post_id` | string | ✅ | 帖子 mid |
| `experiment_id` | string | | 实验 ID（测试数据无此字段，正式数据有） |
| `time_point` | string | ✅ | 时间点：`t0`, `t2h`, `t4h`, `t8h`, `t12h`, `t24h`, `t48h`, `t72h` |
| `comments` | number | ✅ | 评论数 |
| `reposts` | number | ✅ | 转发数 |
| `likes` | number | ✅ | 点赞数 |
| `raw_metadata` | string | | 原始指标 JSON（含更多字段） |
| `collected_at` | string | ✅ | 采集时间 |
| `created_at` | string | ✅ | 写入时间 |

---

## 五、遗留集合

### `post_snapshots` — 旧版指标快照（已废弃）

早期实验残留，字段命名不同（`comments_count` 而非 `comments`），当前统一使用 `weibo_post_snapshots`。

| 字段 | 类型 |
|------|------|
| `experiment_id` | ObjectId |
| `post_id` | ObjectId |
| `mid` | string |
| `time_point` | string |
| `comments_count` | number |
| `reposts_count` | number |
| `likes_count` | number |
| `captured_at` | string |

---

## 六、调度辅助集合

### `collection_errors` — 采集失败记录

analyzer 采集过程中失败的帖子记录在此，供 `retry-collector` 空闲时背压重试。成功则自动清除。

| 字段 | 类型 | 必填 | 说明 |
|------|------|:---:|------|
| `experiment_id` | string | ✅ | 实验 ID |
| `post_id` | string | ✅ | 帖子 posts._id 字符串（唯一键） |
| `mid` | string | | 微博 mid，方便查询 |
| `error_msg` | string | ✅ | 最后一次失败的错误消息（截断至 200 字符） |
| `retry_count` | number | ✅ | 已重试次数，每次失败 +1 |
| `last_error_at` | string | ✅ | 最后一次失败时间 (ISO 8601) |

**生命周期**:
1. analyzer 采集失败 → `upsert` 写入，retry_count=0
2. retry-collector 重试失败 → `upsert` 更新 retry_count+1
3. 任一次重试成功 → `deleteOne` 清除记录

---

## 七、数据流全景

```
                     ┌──────────────────────┐
                     │   weibo_accounts      │  Cookie 凭据
                     │   experiment_users    │  平台登录
                     └──────────┬───────────┘
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                  ▼
     experiment_runs        posts           comment_templates
     (实验运行)            (实验帖子)          (评论模板)
              │                 │
              │    ┌────────────┘
              │    │  analyzer.ts 采集
              ▼    ▼
     ┌────────────┬──────────────────┬─────────────────┐
     │            │                  │                  │
     ▼            ▼                  ▼                  ▼
post_detail  post_comment_meta  post_user_meta   comment_snapshots
(帖子原始)    (评论原始JSON)     (用户原始JSON)    (结构化评论+树)
                                                      
              post_snapshots
              (指标时间序列 t0~t72h)
```

**关键 API 对应关系**:
| 溯源表 | 来源 API | 接口路径 |
|--------|---------|---------|
| `weibo_post_detail` | `fetchStatusRaw` | `/ajax/statuses/show` |
| `weibo_post_comment_meta` | `getAllComments` | `/ajax/statuses/buildComments` |
| `weibo_post_user_meta` | `getUserProfile` | 用户信息接口 |
