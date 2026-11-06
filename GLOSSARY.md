# Glossary

## 媒体与库

**MediaTitle**：
一部电影、电视剧或动漫的持久身份，通常由 TMDB ID 确定。
_Avoid_: 媒体条目、影片记录

**MediaType**：
内容的 TMDB 语义类型：`movie`、`tv`、`anime`。它决定搜索与获取判断，不直接决定落盘货架。
_Avoid_: 分类、库类型

**LibraryCategory**：
媒体在网盘与 Emby 中的货架分类：电影、电视剧、综艺、动漫。一个 `MediaType` 为 `tv` 的作品可以是电视剧，也可以是综艺。
_Avoid_: 媒体类型、盘目录

**TrackedSeason**：
持续追踪与覆盖判断的单元，属于某个账户，而不是某块网盘。
_Avoid_: 订阅、任务

**Obtained**：
某一集或某部电影已经在**本系统追踪的网盘**中被验证为真实存在。它带有网盘归属。
_Avoid_: 已入库、已下载

**AvailableInEmby**：
媒体已经在 Emby 的任意媒体库中存在。它满足覆盖判断并阻止再次搜索，但**不是** `Obtained`，也不产生网盘副本记录。
_Avoid_: 已获取、Emby 已下载

**DriveLibraryRoot**：
某块已连接网盘上，某一 `LibraryCategory` 的根路径。不同网盘可以配置不同的根路径。
_Avoid_: 保存目录、下载路径

**Unsupported Storage**：
品牌已不再受支持的已连接网盘。它被冻结并隐藏，不再参与获取，但历史记录保留。
_Avoid_: 已删除网盘、失效网盘

## 搜索与候选

**Candidate Note（候选备注）**：
搜索源随候选下发的自由文本，补充标题无法表达的覆盖范围、字幕语言、发布组等信息。它是候选的说明，不是候选的身份，系统不做结构化解析。
_Avoid_: 集号、结构化集信息、副标题

## 工作流与通知

**WorkflowRun**：
一次获取、初始化或巡检的持久执行记录，具有明确的状态与审计事件。
_Avoid_: 任务、作业

**Patrol**：
按计划触发的一轮巡检，会入队若干 `type3_monitor` 运行；它不是一种独立的工作流类型。
_Avoid_: 定时任务、监控

**Notification**：
面向人的推送消息，例如企业微信群机器人。
_Avoid_: Webhook、事件

## 约束

**Snapshot-bound**：
只能操作本次运行中实际观察过的资源快照与候选。
_Avoid_: 缓存结果、上次搜索

**Force-reread**：
写操作完成后必须重新读取网盘真实状态，以读回结果作为事实。
_Avoid_: 接口成功、转存成功

**Drive-verified**：
只有在本系统追踪的网盘中读到真实文件，才能记为 `Obtained`。
_Avoid_: Emby 存在、接口返回成功

**Landed**：
一次运行真正写入了新文件（新集入库或替换成功）；巡检无变化、或仅因 Emby 已有而跳过，都不算。
_Avoid_: 运行成功、有资源

