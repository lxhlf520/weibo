# 微博AI评论实验平台 — MongoDB 数据表设计

## 实验流程概览

```
关键词搜索 → Post硬性筛选 → AI三层过滤 → 用户去重
    → 随机分组 (control/low/high) → 分配评论模板
    → t0基线采集 → 发送AI评论 (low/high组)
    → t2h/t4h/t8h/t12h/t24h/t48h/t72h 定时采集
    → 结果分析 (对照组 vs 实验组差异)
```

---

## 一、基础设施表（非实验数据）

### 1. experiment_users
实验用户（多用户隔离）

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| token | string | 唯一认证Token |
| name | string | 用户名称 |
| created_at | Date | |

### 2. weibo_accounts
微博账号池

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| user_id | string | 关联 experiment_users._id |
| cookie | string | 登录Cookie |
| weibo_uid | string | 微博UID |
| nickname | string | 昵称 |
| avatar | string | 头像URL |
| status | string | active/expired/banned/error |
| daily_comment_count | number | 今日已评论数 |
| max_daily_comments | number | 日评论上限 |
| last_used_at | Date | |
| created_at | Date | |
| updated_at | Date | |

### 3. comment_templates
评论模板

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| post_group | string | low / high |
| content | string | 模板内容 |
| is_active | boolean | |
| sort_order | number | |
| created_at | Date | |

---

## 二、实验核心表

### 4. experiment_runs → 实验运行记录

一次完整的实验运行。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| user_id | string | 关联 experiment_users |
| name | string | 实验名称（如 "2026-07-01 日常话题A组"） |
| date | Date | 实验日期 |
| status | string | draft → screening → baseline → intervention → collecting → completed |
| config | object | 实验配置参数 |
| config.keywords | string[] | 搜索关键词 |
| config.maxHoursAgo | number | 帖子时效上限（小时） |
| config.minComments | number | 评论数下限 |
| config.maxComments | number | 评论数上限 |
| config.maxFollowers | number | 粉丝数上限 |
| config.totalPosts | number | 目标帖子数 |
| config.controlCount | number | 对照组数量 |
| config.lowCount | number | 低强度组数量 |
| config.highCount | number | 高强度组数量 |
| screening_summary | object | 筛选结果摘要 |
| screening_summary.totalSearched | number | 搜索到总数 |
| screening_summary.totalPassed | number | 通过筛选数 |
| screening_summary.totalRejected | number | 被拒绝数 |
| intervention_started_at | Date | 评论发送开始时间 |
| intervention_completed_at | Date | 评论发送完成时间 |
| created_at | Date | |
| updated_at | Date | |

**索引**: `{ user_id: 1, created_at: -1 }`, `{ status: 1 }`

---

### 5. posts → 实验帖子池

筛选进入实验的每条帖子。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| user_id | string | 关联 experiment_users |
| experiment_id | string | 关联 experiment_runs |
| post_id | string | 微博帖子ID (如 "4462762761612094") |
| post_url | string | 帖子链接 |
| content | string | 帖子正文 |
| author_uid | string | 作者UID |
| author_name | string | 作者昵称 |
| author_followers | number | 作者粉丝数 |
| **author_profile_raw** | **object** | ★ `profile/info` API 原始响应 |
| comments_count | number | 当前评论数 |
| reposts_count | number | 当前转发数 |
| likes_count | number | 当前点赞数 |
| post_group | string | control / low / high |
| pseudo_time | Date | 分配给对照组的伪发布时间 |
| published_at | Date | 帖子原始发布时间 |
| **search_raw** | **object** | ★ `side/search` API 原始响应（搜索结果中此帖的原始JSON） |
| screening | object | 筛选记录 |
| screening.passed | boolean | 是否通过 |
| screening.failReason | string | 未通过原因 |
| screening.filters_applied | object | 各项过滤结果 |
| screened_at | Date | 筛选时间 |

**索引**: `{ experiment_id: 1, post_group: 1 }`, `{ user_id: 1 }`, `{ post_id: 1 }`

---

## 三、数据采集结果表 ★

### 6. metric_snapshots → 帖子指标时间序列快照

**这是核心结果表**，记录每个时间点的帖子指标，保存API原始响应。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | 关联 experiment_runs |
| post_id | string | 关联 posts |
| time_point | string | t0 / t2h / t4h / t8h / t12h / t24h / t48h / t72h |
| comments | number | 评论数 |
| reposts | number | 转发数 |
| likes | number | 点赞数 |
| **raw_api_response** | **object** | ★ `statuses/show` API 完整原始响应 |
| **raw_api_endpoint** | **string** | ★ 数据来源API端点 |
| **raw_api_status** | **number** | ★ API HTTP状态码 |
| collected_at | Date | 采集时间 |

**索引**: `{ experiment_id: 1, time_point: 1 }`, `{ post_id: 1, time_point: 1 }` (唯一复合索引)

---

### 7. comment_snapshots → 评论采集快照

每次采集帖子评论树时的完整数据，保留API原始响应。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | 关联 experiment_runs |
| post_id | string | 关联 posts |
| time_point | string | t0 / t2h / ... / t72h |
| comment_id | string | 微博评论ID |
| parent_comment_id | string | 父评论ID（用于构建评论树） |
| root_comment_id | string | 根评论ID |
| content | string | 评论正文 |
| commenter_uid | string | 评论者UID |
| commenter_name | string | 评论者昵称 |
| like_count | number | 评论点赞数 |
| comment_time | Date | 评论发布时间 |
| is_experiment_comment | boolean | ★ 是否为本实验发送的AI评论 |
| experiment_comment_id | string | ★ 如是AI评论，关联 intervention_logs |
| **raw_api_response** | **object** | ★ `comments/buildcomments` API 原始响应（含此评论所在页的完整JSON） |
| **raw_comment_index** | **number** | ★ 此评论在API响应数组中的位置 |
| collected_at | Date | |

**索引**: `{ post_id: 1, time_point: 1 }`, `{ experiment_id: 1 }`, `{ root_comment_id: 1 }`

---

### 8. intervention_logs → 干预日志（AI评论发送记录）

每条AI评论的发送记录及结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | 关联 experiment_runs |
| post_id | string | 关联 posts |
| account_id | string | 使用的微博账号 |
| post_group | string | low / high |
| comment_template | string | 使用的模板内容 |
| comment_content | string | 实际发送内容 |
| weibo_comment_id | string | 微博返回的评论ID |
| status | string | pending → sent → failed / skipped |
| error_message | string | 失败原因 |
| **raw_send_response** | **object** | ★ `comments/create` API 完整原始响应 |
| sent_at | Date | 发送时间 |
| created_at | Date | |

**索引**: `{ experiment_id: 1 }`, `{ post_id: 1 }`, `{ status: 1 }`

---

## 四、结果分析表

### 9. outcome_analysis → 实验结局分析

每个帖子在实验结束后的最终指标变化。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | |
| post_id | string | |
| post_group | string | control / low / high |
| baseline | object | t0 基线 |
| baseline.comments | number | |
| baseline.reposts | number | |
| baseline.likes | number | |
| final | object | t72h 终值 |
| final.comments | number | |
| final.reposts | number | |
| final.likes | number | |
| delta | object | 变化量 = final - baseline |
| delta.comments | number | |
| delta.reposts | number | |
| delta.likes | number | |
| calculated_at | Date | |

**索引**: `{ experiment_id: 1, post_group: 1 }`

---

### 10. experiment_summary → 实验汇总报告 ★ 新增

按实验+分组汇总的结果。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | |
| post_group | string | control / low / high |
| post_count | number | 该组帖子数 |
| metrics | object | 汇总指标 |
| metrics.avg_delta_comments | number | 平均评论增量 |
| metrics.avg_delta_reposts | number | 平均转发增量 |
| metrics.avg_delta_likes | number | 平均点赞增量 |
| metrics.median_delta_comments | number | 中位数评论增量 |
| metrics.median_delta_reposts | number | |
| metrics.median_delta_likes | number | |
| metrics.std_delta_comments | number | 评论增量标准差 |
| **statistical_tests** | **object** | ★ 统计检验结果 |
| statistical_tests.vs_control_p_value | number | vs 对照组的 p值 |
| statistical_tests.effect_size | number | 效应量 (Cohen's d) |
| significant | boolean | 是否统计显著 |
| raw_snapshots_count | number | 总快照数 |
| calculated_at | Date | |

**索引**: `{ experiment_id: 1 }`

---

## 五、原始数据审计表 ★

### 11. api_raw_logs → API原始数据日志

**所有API调用的完整记录**，作为数据溯源和问题排查的依据。

| 字段 | 类型 | 说明 |
|------|------|------|
| _id | ObjectId | |
| experiment_id | string | 关联实验（搜索/筛选阶段可为null） |
| post_id | string | 关联帖子 |
| time_point | string | 采集时间点 |
| api_endpoint | string | API端点，如 `side/search`, `statuses/show`, `comments/buildcomments`, `profile/info`, `comments/create` |
| request_url | string | 完整请求URL |
| request_params | object | 请求参数 |
| request_headers_summary | object | 请求头摘要（脱敏后） |
| response_status | number | HTTP状态码 |
| response_body | object | ★ 完整原始响应JSON |
| response_size_bytes | number | 响应体大小 |
| duration_ms | number | 请求耗时 |
| error | string | 错误信息（如有） |
| collected_at | Date | |

**索引**: `{ experiment_id: 1, api_endpoint: 1 }`, `{ post_id: 1 }`, `{ collected_at: -1 }`

**TTL索引**: 建议对 `collected_at` 设置 90 天 TTL（原始数据量大时可自动清理）

---

## 六、数据流对应关系

```
搜索阶段:
  side/search → posts.search_raw + api_raw_logs

筛选阶段:
  comments/buildcomments (AI过滤) → api_raw_logs
  posts.screening → 记录通过/拒绝

分组阶段:
  experiment_runs.config → 记录分组参数
  posts.post_group → 分配组别

干预阶段:
  comments/create → intervention_logs (含 raw_send_response)

采集阶段 (t0~t72h):
  statuses/show → metric_snapshots (含 raw_api_response)
  comments/buildcomments → comment_snapshots (含 raw_api_response)
  每次API调用 → api_raw_logs (完整审计)

分析阶段:
  metric_snapshots → outcome_analysis (计算delta)
  outcome_analysis → experiment_summary (分组汇总 + 统计检验)
```

---

## 七、与旧PG Schema对比

| PG表 | MongoDB Collection | 变化 |
|------|-------------------|------|
| experiment_users | experiment_users | id: ObjectId |
| weibo_accounts | weibo_accounts | id: ObjectId |
| experiment_runs | experiment_runs | +name, +config, +screening_summary |
| posts | posts | +author_profile_raw, +search_raw, +screening嵌套 |
| post_snapshots | metric_snapshots | +raw_api_response, +raw_api_endpoint, +raw_api_status |
| comment_snapshots | comment_snapshots | +raw_api_response, +is_experiment_comment |
| intervention_logs | intervention_logs | +raw_send_response |
| outcome_analysis | outcome_analysis | 结构不变 |
| comment_templates | comment_templates | 结构不变 |
| (无) | **experiment_summary** | ★ 新增：分组汇总+统计检验 |
| (无) | **api_raw_logs** | ★ 新增：全量API原始数据审计 |
