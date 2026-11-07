# 巡影 × USPAI 媒体入库对接确认

- 版本：v1.0
- 日期：2026-11-06
- 对接双方：巡影（mediary-scout，资源服务方）/ USPAI（媒体自动化系统）

> 本版按 USAPI v0.6 的“一次性提交”模型定稿：
>
> - 4 个状态：`following` / `completed` / `no_resource` / `failed`
> - USAPI 每个季只提交一次，`following` 视为已受理终态；3 次早期检查后改为每日对账
> - 字幕可任意顺序投递，USAPI 自己处理晚到关联文件
> - 内网直连、不鉴权，基础地址 `http://192.168.123.148:3000`
>
> 本版为定稿版，接口、状态、目录和联调信息均已确认。

---

## 1. 已确认口径

| 项目 | 结论 |
|---|---|
| 角色 | 巡影搜索、选源、转存，落到约定交付目录；USAPI 负责识别、STRM、Emby、豆瓣回写、通知 |
| 网络与鉴权 | 内网直连，不暴露公网、不鉴权；基础地址 `http://192.168.123.148:3000` |
| 账号 | 单实例、单 115 账号；不做 `account_ref` 映射 |
| 识别 | USAPI 解析豆瓣后传 `tmdb_id`；巡影不接豆瓣 ID |
| 提交模型 | USAPI 每季只提交一次；`following` 视为已受理终态，不持续轮询 |
| 检查与对账 | 1 分钟、10 分钟、1 小时各查一次；之后每天查一次，直到终态或有文件入库 |
| 对账停止影响 | 只停止 USAPI 查询；电影不再投递，剧集巡影继续追踪，115 watcher 仍可入库 |
| `year` 不一致 | 仅告警，目录命名以 TMDB 元数据为准 |
| 字幕 | 任意顺序；USAPI 自己处理晚到关联文件 |
| Emby | 复用巡影现有 Emby 配置（同一台，已确认）；电影/电视剧/综艺/动漫四个库名都需一致；巡影只读、不触发扫描；USAPI 负责扫描 |
| 幂等 | `request_id` 实例唯一；重复提交返回原任务 |
| 回调 | 不做 |
| 终态路径 | 不返回 `target.paths`；USAPI 通过 115 事件识别 |
| 取消 | 本期不做 |
| 状态 | `following` / `completed` / `no_resource` / `failed` |
| 追踪规则 | **电影无资源不追；剧集（含未上映）持续追踪** |

---

## 2. 状态与追踪规则

### 2.1 通用状态

| 状态 | 含义 | USAPI 动作 |
|---|---|---|
| `following` | 已受理、处理中、部分已交付、持续追更 | 视为已受理终态，释放队列；3 次早期检查 + 每日对账 |
| `completed` | 当前请求已完整交付，且不会再有后续 | 记为完成 |
| `no_resource` | 当前时点没有可用资源 | 按 `reason` 回落订阅或告警 |
| `failed` | 服务错误 | 按 `error.retryable` 有限重试或告警 |

### 2.2 电影

- 已在 Emby → 创建响应直接 `completed`，`already_exists=true`。
- 未上映 → `no_resource` + `reason=UNRELEASED`。
- 已上映但无资源 → `no_resource` + `reason=NO_RESOURCE`。
- 交付完成 → `completed`。
- 服务错误 → `failed`。
- **`no_resource` 后巡影不再追踪**，电影由 USAPI 走 MoviePilot 订阅。

### 2.3 剧集

- 尚无已播集 / 未上映 → `following`，巡影继续追踪，等新集播出后自动投递。
- 连载中暂无资源 → `following`，巡影继续追踪。
- 已完结季无资源 → `following`，巡影继续追踪。
- 部分集已交付、仍有缺集 → `following`，巡影继续追。
- 季已完结且全部获取 → `completed`。
- 服务错误 → `failed`。
- **剧集不返回 `no_resource`**；所有非电影情况都由巡影继续追踪，USAPI 不订阅。

### 2.4 创建时的终态

创建接口可能直接返回：

- `completed`：电影已在 Emby；或剧集整季完结且全部在 Emby，`already_exists=true`；
- 连载中剧集即使当前集都在 Emby，也返回 `following`；
- `no_resource`：电影未上映 / 无资源；
- `failed`：参数错误、Emby 不可达、创建时已知的存储鉴权问题；
- 其他：`following`。

---

## 3. 接口

- 基础地址：`http://192.168.123.148:3000`
- 内网直连，不鉴权。
- 本组 `/api/v1/ingest/*` 接口不鉴权；巡影现有 `/api/agent/*` 仍保留 Bearer token，不受影响。

### 3.1 创建任务

```http
POST http://192.168.123.148:3000/api/v1/ingest/tasks
Content-Type: application/json
```

```json
{
  "request_id": "usapi-20261106-a91d7b",
  "media": {
    "tmdb_id": "275297",
    "type": "series",
    "season_number": 2,
    "year": 2026,
    "title": "走马上任"
  },
  "options": {
    "quality": "best"
  }
}
```

| 字段 | 类型 | 必须 | 说明 |
|---|---|---|---|
| `request_id` | string | 是 | 幂等键，实例唯一，最大 64 字符 |
| `media.tmdb_id` | string | 是 | 巡影按 TMDB 定位 |
| `media.type` | string | 是 | `movie` 或 `series` |
| `media.season_number` | integer | 剧集必须 | 从 1 开始 |
| `media.year` | integer | 是 | 校验和日志用；目录命名以 TMDB 元数据为准 |
| `media.title` | string | 否 | 展示和日志用 |
| `options.quality` | string | 否 | `best` / `4k` / `1080p`，默认 `best`；其他值按 `best` |

成功响应：

```json
202 Accepted
{
  "code": 200,
  "message": "已受理",
  "data": {
    "task_id": "vendor-task-0001",
    "request_id": "usapi-20261106-a91d7b",
    "status": "following",
    "deduplicated": false,
    "created_at": "2026-11-06T12:30:00+08:00"
  }
}
```

- 重复 `request_id` 返回 HTTP `200`，`deduplicated: true`，并返回原任务。
- 创建时如果直接返回 `completed` / `no_resource` / `failed`，`data` 中同样携带 `already_exists` / `reason` / `error` / `finished_at`，与查询接口一致。

### 3.2 查询任务

```http
GET http://192.168.123.148:3000/api/v1/ingest/tasks/{task_id}
```

```json
{
  "code": 200,
  "message": "ok",
  "data": {
    "task_id": "vendor-task-0001",
    "request_id": "usapi-20261106-a91d7b",
    "status": "following",
    "message": "已交付 9 集，继续追踪",
    "already_exists": false,
    "reason": null,
    "error": null,
    "created_at": "2026-11-06T12:30:00+08:00",
    "finished_at": null
  }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | string | `following` / `completed` / `no_resource` / `failed` |
| `message` | string | 当前阶段或结果说明，可选 |
| `already_exists` | boolean | 仅 `completed` 时有效：是否因已在 Emby 而跳过 |
| `reason` | string | 仅 `no_resource` 时有效：`NO_RESOURCE` / `UNRELEASED` |
| `error` | object | 仅 `failed` 时有效：`{ code, message, retryable }` |
| `created_at` | string | 创建时间 |
| `finished_at` | string | 终态时间；`following` 时为 `null` |

### 3.3 HTTP 状态

| HTTP | 场景 |
|---|---|
| `202` | 创建成功（包括直接返回 `completed` / `no_resource` / `failed`） |
| `200` | 重复提交返回原任务 / 查询成功 |
| `400` | 参数不合法 |
| `404` | 查询的任务不存在：`data.error_code = TASK_NOT_FOUND`，不可重试 |
| `500` | 服务内部错误 |

> 安全：不鉴权意味着该接口等价于内网管理接口。请确保 `3000` 端口只对 USAPI 所在网段开放，不做公网端口映射；如机器有多网卡，建议只监听内网地址。

---

## 4. 任务生命周期

- USAPI 每季只提交一次，创建后立即释放串行队列。
- 创建返回 `following` 后，USAPI 做 3 次早期检查：1 分钟、10 分钟、1 小时。
- 之后改为每天对账一次，直到任务进入终态或已有文件入库。
- 实际入库由 115 文件事件和 Emby webhook 驱动。
- 巡影内部继续追踪剧集同季新集，投递到同一季目录；不改 API 任务状态。
- 电影在 `no_resource` / `failed` 后不再追踪。
- 剧集在 `following` 下持续追踪，直到 `completed` 或 `failed`。

---

## 5. 目录与交付

- 交付根：`/最近接收/Mediary Scout`
- 分类目录：`Movies` / `TV` / `Variety` / `Anime`（名称可配置）。
- 电影：`Movies/<片名 (年份) {tmdb-N}>/<视频文件>`
- 电视剧：`TV/<剧名 (年份) {tmdb-N}>/Season NN/<视频文件>`
- 综艺：`Variety/<名称 (年份) {tmdb-N}>/Season NN/<视频文件>`
- 动漫：`Anime/<名称 (年份) {tmdb-N}>/Season NN/<视频文件>`
- provider 模式保留巡影原有的媒体分类：动画剧集进 `Anime`，综艺进 `Variety`，其余剧集进 `TV`，不强制全部进 TV。
- USAPI watcher 监听父目录 `/最近接收/Mediary Scout`，覆盖 `Movies` / `TV` / `Variety` / `Anime` 四个分类目录（已确认）。
- TV 暂存：`staging-<workflowRunId>`，任务结束后清理。
- 电影没有独立 `staging-`：文件可能先出现在包装子目录，拍平后移到第一层；USAPI 跳过包装层。
- 只移动完整文件，不出现 `.part` / `.tmp`。
- 字幕、nfo、海报等可以任意顺序到达；USAPI 自己匹配和移动。
- 巡影不移动文件夹、不调用 Emby 扫描、不生成 STRM、不发送通知。

---

## 6. Emby

复用巡影现有的 Emby 配置，不需要 USAPI 额外提供地址或 Key。

已确认：

- 巡影当前连接的 Emby 与 USAPI 使用的是同一台
- 电影 / 电视剧 / 综艺 / 动漫四个媒体库名称都与巡影设置一致
- Emby 条目已刮削出 TMDB ID

巡影在 provider 模式下只读 Emby，不触发 `/Library/Refresh`。

巡影负责：

- 只读 Emby，判断电影 / 集是否已存在。
- 不调用 `/Library/Refresh`。
- Emby 查询失败 **fail-closed**：任务返回 `failed`，`error.code = EMBY_UNAVAILABLE`，不继续搜索和转存。
- Emby 已有集只参与缺集计算，不写入巡影 `Obtained`。
- 结合自身 `Obtained`，避免 USAPI 扫描延迟造成重复交付。
- 剧集去重时按 TMDB ID 联合查询 电视剧 / 综艺 / 动漫 三个媒体库，不依赖双方分类口径一致；即使巡影判为动漫、USAPI 最终入库到电视剧，也能识别为已有，避免重复投递。

---

## 7. 错误码

| 错误码 | 含义 | retryable |
|---|---|---|
| `INVALID_ARGUMENT` | 参数不合法 | 否 |
| `STORAGE_AUTH_EXPIRED` | 115 Cookie 失效，需要重新授权 | 否 |
| `QUOTA_EXCEEDED` | 115 空间不足 | 否 |
| `EMBY_UNAVAILABLE` | Emby 不可达 | 是 |
| `MEDIA_NOT_FOUND` | 媒体不存在 | 否 |
| `SEASON_NOT_FOUND` | 季不存在 | 否 |
| `TEMPORARY_FAILURE` | 搜索源 / TMDB / 网络临时故障 | 是 |
| `INTERNAL_ERROR` | 服务内部错误 | 是 |

TMDB 明确返回 404 时映射为 `MEDIA_NOT_FOUND`（电影）或 `SEASON_NOT_FOUND`（剧集），两者都不可重试；只有传输层失败（fetch failed / 超时）才归入 `TEMPORARY_FAILURE`。

USAPI 重试约定：

- `EMBY_UNAVAILABLE` / `TEMPORARY_FAILURE` / `INTERNAL_ERROR`：最多 3 次，指数退避。
- 重试使用新的 `request_id`。
- 其他错误不重试，告警或通知用户。

---

## 8. 幂等、重试与保留

### 8.1 幂等

- `request_id` 实例唯一，幂等窗口不少于 7 天。
- 同一 `request_id` 重复提交返回原任务；终态重复提交返回原终态。
- 重复 `request_id` 但 payload 不同：返回原任务并忽略新 payload，日志告警。
- 巡影任务记录保留 30 天；超过 30 天的旧 `request_id` 会创建新任务。

### 8.2 重试

- 创建时返回 `failed` / `no_resource` 的任务不建追踪；新 `request_id` 直接重新开始。
- 异步失败：
  - 没有落盘文件 → 释放追踪；新 `request_id` 重新开始。
  - 已有部分文件 → 保留文件和追踪；新 `request_id` 作为补缺再跑一轮。
- 剧集 `following` 的追踪记录会保留；新 `request_id` 绑定已有季，不重复建任务。
- 电影 `no_resource` 后不追踪；新 `request_id` 重新开始。

### 8.3 每日对账

3 次早期检查（1 分钟、10 分钟、1 小时）之后，USAPI 每天对任务查一次，直到：

- 任务进入终态：`completed` / `no_resource` / `failed`；
- 已经有文件入库（115 事件或 Emby webhook 已处理）；
- 用户在 USAPI 本地 `ignore` 该任务。

每天查询时：

- `failed` / `no_resource` → 按错误处理；
- `following` → 不处理，继续每天查；
- `completed` → 记为完成。

建议对超过 30 天仍无文件的任务停止对账并记录日志，避免无限累积。

超过 30 天停止对账只影响 USAPI 的查询：

- 电影：巡影已不追踪，不会再有新文件；
- 剧集：巡影继续内部追踪，后续新集仍会投递，USAPI 的 115 watcher 仍可入库；
- 用户本地 `ignore` 同理，不影响巡影继续投递。

---

## 9. 本期不做

- 完成回调
- 取消任务
- `target.dir` / `target.paths`
- `account_ref` 多账号映射
- `stage` / `progress`
- 巡影触发 Emby 扫描
- 巡影发送用户通知
- 自动补下一季

---

## 10. 联调信息（已确认）

- 网络：USAPI 与巡影在同一台服务器，`http://192.168.123.148:3000` 可达。
- 端口：3000 只对 USAPI 网段开放，不做公网映射。
- 115：使用同一 115 账号下的测试媒体和测试目录。
- 分类目录：USAPI watcher 监听父目录，覆盖 `Movies` / `TV` / `Variety` / `Anime`（已确认）。
- 订阅分工：电影 `no_resource` 后由 USAPI 走 MoviePilot 订阅；剧集由巡影继续追踪，USAPI 不订阅。
- 联调联系人：由 USAPI 侧统一把控。

### 10.1 联调建议片单

优先用小体积、资源充足且尚未入库的电影，避免长时间转存和配额消耗：

| 用途 | 片名 | TMDB ID | 说明 |
|---|---|---|---|
| 电影主用例 | 彗星来的那一夜 / Coherence | `220289` | 2014 年，约 89 分钟，115 资源多为 1–2GB |
| 电影备选 | 这个男人来自地球 / The Man from Earth | `13363` | 2007 年，约 87 分钟，场景单一、版本体积小 |
| 剧集用例 | 银翼杀手2099 / Blade Runner 2099 | `171802` | 2026-11-25 首播，第 1 季 8 集；未开播验证 `following` 与后续新集投递 |

---

## 11. 验收用例

| 编号 | 场景 | 预期 |
|---|---|---|
| 1 | 电影已在 Emby | `completed`，`already_exists=true` |
| 2 | 普通电影 | 创建 `following`，USAPI 记为已提交；文件出现在 `Movies/<片名 (年份) {tmdb-N}>/` |
| 3 | 电影未上映 | `no_resource`，`reason=UNRELEASED`；USAPI 走 MoviePilot 订阅 |
| 4 | 电影无资源 | `no_resource`，`reason=NO_RESOURCE`；USAPI 可订阅 |
| 5 | 剧集第 2 季 | 只保存 `Season 02` |
| 6 | 连载剧第 2 季 | 创建 `following`；同季新集继续投递；USAPI 不持续轮询 |
| 7 | 剧集未上映 / 尚无已播集 | `following`；巡影继续追踪；USAPI 不订阅 |
| 8 | 已完结季缺集 | `following`；巡影继续追 |
| 9 | 剧集完结且齐全 | `completed` |
| 10 | 同一 `request_id` 重复提交 | 返回同一 `task_id`，`deduplicated=true` |
| 11 | Emby 不可达 | `failed`，`EMBY_UNAVAILABLE`；USAPI 最多重试 3 次 |
| 12 | 115 Cookie 失效 | `failed`，`STORAGE_AUTH_EXPIRED`；USAPI 通知用户 |
| 13 | 字幕在视频之后到达 | USAPI 匹配并移动到影视库 |
| 14 | 电影带包装层目录 | USAPI 跳过包装层；拍平后接盘 |
| 15 | 早期检查 3 次后仍 `following` | USAPI 转为每日对账，等待 115 事件 |
| 16 | 巡影触发 Emby 扫描 | 不应发生 |
| 17 | 失败后用新 `request_id` 重试 | 无文件重新开始；有部分文件则补缺 |
| 18 | 晚于 1 小时失败 | 每日对账发现后处理 |
| 19 | 任务已有文件入库 | 停止每日对账 |
| 20 | 创建时直接返回终态 | `data` 携带 `already_exists` / `reason` / `error` / `finished_at` |
| 21 | 连载中剧集当前集都在 Emby | 返回 `following`，不是 `completed` |
| 22 | `year` 与 TMDB 不一致 | 仅告警，目录命名以 TMDB 为准 |
| 23 | 30 天后停止对账 | 电影不再投递；剧集继续追踪，115 watcher 仍可入库 |
| 24 | 动漫剧集 | 保存到 `Anime/<名称 (年份) {tmdb-N}>/Season NN/` |
| 25 | 综艺 | 保存到 `Variety/<名称 (年份) {tmdb-N}>/Season NN/` |
