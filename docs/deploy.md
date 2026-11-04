# Deploy Mediary Scout

Mediary Scout 以 Docker Compose 部署（NAS / 软路由 / VPS / 闲置 PC）：

| | Docker Compose |
|---|---|
| 适合 | NAS / 软路由 / VPS / 闲置 PC |
| 数据层 | Postgres |
| 部署 | `docker compose up -d` |
| 升级 | `./scripts/deploy.sh` |

> **English summary.** Self-host with one command — `docker compose up -d` brings up web (Next.js + in-process worker) + Postgres + a bundled PanSou. Open `http://<host>:3000`, go to Settings, scan-login your drive (115 / Quark by QR), add an OpenAI-compatible LLM endpoint, and you're running. It is intended for local / LAN use — **never expose `:3000` raw to the internet**. Full walkthrough below (Chinese).

一行命令起整套:**web(Next + 进程内 worker)+ Postgres + 自带 PanSou**。本指南覆盖:选宿主 → compose 起服务 → 从自己的设备访问 → 安全/升级。

## 目录
- [让 AI agent 帮你部署](#让-ai-agent-帮你部署)
- [选择你的宿主](#选择你的宿主)
- [Compose 快速开始](#compose-快速开始)
- [想跑真实获取还需要](#想跑真实获取还需要)
- [可选增强](#可选增强)
- [访问方式](#访问方式)
- [安全](#安全)
- [多用户与忘记密码](#多用户与忘记密码)
- [国内构建加速](#国内构建加速docker-hub-常年不稳定)
- [升级](#升级)
- [备份与恢复](#备份与恢复pgdata)

## 让 AI agent 帮你部署

想让 AI agent(Claude Code、Codex、opencode 等)带你部署,把下面这段提示词丢给它,它会先问清楚再替你执行:

````markdown
你要部署 Mediary Scout(巡影),一个自部署的媒体获取 agent。按仓库 docs/deploy.md 来。按下面顺序问用户,然后执行。

## 必问(没答案别开始)
1. **部署到哪台机器?** NAS / 软路由 / 闲置 PC / VPS,以及我怎么操作它——SSH 进去,还是在它本机终端跑命令?
2. **单账号还是多账号?** 默认单账号(就你自己用)。多账号让家人/朋友各注册、各绑自己的网盘、各看各的库。

## 建议问(有默认,但确认偏好)
3. **现在就配真实获取,还是先起来看看?** 真实获取需要一块支持的网盘(115 / 夸克)+ 一个 OpenAI 兼容的 AI 模型接口。先不配也能起来看界面,之后在设置页配。

## 可选——一句话问,都不需要就跳过
4. 这些可选项有想现在配的吗?都不需要就回「跳过」:
   - 通知推送(Bark / Server酱 / 企业微信 / webhook)
   - 自己的 TMDB key(不配默认走作者代理,开箱即用)
   - Prowlarr 磁力聚合(仅 115 支持磁力)
   - Emby 联动(已有集跳过搜索)
   - SmartStrm 自动化 Webhook(夸克落盘后生成 .strm；115 由 Emby 直接挂载，无需触发)
   - 国内构建加速(registry mirror + npm 镜像)

## 然后执行
- `git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout`
- 国内构建加速(首次 `up` **之前**):按本文「国内构建加速」一节配镜像加速——Linux(软路由 / NAS 上直接装的 Docker)改 `/etc/docker/daemon.json`,Docker Desktop(macOS / Windows)在它自己的设置里改;npm 镜像用 `docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com`
- `docker compose up -d`(首次构建要几分钟)
- 多账号:在 `.env` 加 `MEDIA_TRACK_MULTI_USER=1`,再 `docker compose up -d web`
- 打开 `http://<主机>:3000`,带用户走设置页(网盘 / AI 模型 / 可选项)
- 确认跑起来,报出网址,并告诉用户:以后升级在部署目录运行 `./scripts/deploy.sh`
````

## 选择你的宿主

任何能跑 Docker 的常开机器都行。挑一个:

- **NAS(群晖 / 威联通 / unRAID)** —— 最推荐(常开、省电)。群晖用 Container Manager、威联通用 Container Station、unRAID 用 Community Apps 的 Compose Manager 插件,把本仓库 `docker-compose.yml` 贴进去起即可。`pgdata` 卷落在阵列/SSD 上。
- **软路由(iStoreOS 等)** —— 作者实测在带镜像加速的 iStoreOS 上一把过。用 Docker 插件或 ssh 跑 compose;软路由存储小,`pgdata` 指到外挂盘。
- **闲置 PC / Linux 主机** —— 装 Docker + Compose 插件,`git clone` 后 `docker compose up -d`。睡眠会停巡检,建议设为常开。
- **VPS** —— 跑得动;115/夸克转存走网盘服务端,VPS 带宽不影响转存速度,只要能连上网盘 API 即可。⚠️ VPS 在公网,务必看[安全](#安全)。

下面的 compose 步骤在以上任何宿主都一样。

## Compose 快速开始

```bash
git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout
docker compose up -d        # 首次会构建 web 镜像,几分钟
```

> ### ⚠️ 墙内先看这个:Docker Hub 大概率拉不动
>
> 本项目有两个镜像来自 Docker Hub(`postgres`、构建 web 用的 `node`),
> 而 **Docker Hub 在中国大陆常年不稳定**。典型报错:
>
> ```
> failed to fetch anonymous token: Get "https://auth.docker.io/token...": EOF
> failed to resolve reference "docker.io/library/node:22-slim"
> read: connection reset by peer
> ```
>
> **这不是你配置错了,重试也没用**(作者实测重试十余次全失败)。在仓库根 `.env` 里
> 加一行镜像源,三处会一起生效:
>
> ```bash
> echo 'DOCKER_MIRROR=docker.1ms.run' >> .env
> docker compose up -d
> ```
>
> 已实测可用(2026-08-01,大陆直连,镜像站都能拉到这两个镜像):
>
> | 镜像源 | 备注 |
> |---|---|
> | `docker.1ms.run` | 作者实测首选 |
> | `dockerproxy.net` | |
> | `docker.m.daocloud.io` | |
> | `hub.rat.dev` | |
>
> **公共镜像站会轮流失效 —— 一个不通就换下一个,别只记住一个。** 验证某站可用:
>
> ```bash
> docker pull docker.1ms.run/library/node:22-slim
> ```
>
> 留空(默认)= 直连 Docker Hub 官方,**境外网络无需任何设置**。
> `pansou` 走 `ghcr.io`,不受此变量影响(墙内通常可直连)。
>
> 另一条路是给 Docker daemon 配全局 `registry-mirrors`(`/etc/docker/daemon.json`),
> 效果一样。`DOCKER_MIRROR` 的好处是只影响本项目、不需要 root、不用重启 daemon。

打开 `http://<你的主机>:3000`:
1. **设置 → 网盘**:在品牌瓦片里选 115 或夸克开始连接,扫码登录（夸克也可粘贴 cookie）;凭证入库后自动用于转存。两块盘可同时绑定,互为独立工作区。
2. 就这样。**TMDB 元数据经作者 CF Worker 开箱即用**(想用自己额度可在设置填 TMDB key);**PanSou 网盘搜索源已自带**。

### 组成 / 端口

| 服务 | 镜像 | 说明 |
|---|---|---|
| `web` | 本仓库 `Dockerfile` | Next.js + 进程内 worker(`instrumentation.ts` 自启),`:3000` |
| `postgres` | `postgres:16-alpine` | 持久卷 `pgdata`;表首次查询自建,无需迁移 |
| `pansou` | `ghcr.io/fish2018/pansou-web` | 网盘搜索源,compose 内经服务名 `http://pansou` 调用 |

### 覆盖配置

`docker-compose.yml` 的 `environment:` 已设好库连接、PanSou 地址、adapters。要覆盖额外项(TMDB / 115 cookie / LLM / Prowlarr / CID),在仓库根放 `.env`(参照 `.env.example`)——compose 会自动加载(缺失也无妨)。

## 网盘目录布局

连接网盘时会在盘里建好 `影视/{电影,电视剧,综艺,动漫}` 四个分类目录。每个盘都能在 **设置 → 网盘 → 媒体库目录** 里自定义根目录（支持多级，如 `影音/影视`）、四个分类名，以及它在 SmartStrm 里的挂载前缀（如 `/115`）；已入库的旧剧集不会被移动。

## 想跑真实获取还需要

- **AI 模型**(设置 → AI 模型):填一个 OpenAI 兼容的 `baseURL / apiKey / modelId`——agent 靠它决策。不填则获取流程无法规划。
- **网盘**(设置 → 网盘):扫码或粘凭证绑定。绑定时会在盘里自动建好 `影视/{电影,电视剧,综艺,动漫}` 四个落盘目录,不用手填目录 ID;目录名可在「媒体库目录」里改。

## 可选增强

- **自己的 TMDB key**(设置 → TMDB 元数据):直连你自己的额度,调不通自动回退作者代理。
- **出站代理**(`.env` 设 `HTTP_PROXY` / `HTTPS_PROXY`):墙内想用**自己的 TMDB token / 额度**时用得到。TMDB 的 API 主机(`api.themoviedb.org`)在国内常被单独墙(官网能开 ≠ API 能通),直连不到你的 token 就用不上。给容器配一个能穿透的代理即可让全部出站请求(TMDB / PanSou / Prowlarr)走它:在仓库根 `.env` 里写 `HTTP_PROXY=http://172.17.0.1:7890` 和 `HTTPS_PROXY=http://172.17.0.1:7890`(`172.17.0.1` 是 Docker 默认网关,指向宿主机;端口换成你宿主上代理软件的实际端口,如 Clash 的 7890),再 `docker compose up -d`。`NO_PROXY` 可排除内网地址。**不设代理时行为不变**——TMDB token 留空走作者内置代理依旧开箱即用,这条只为「墙内 + 想用自己 token」准备。
  - **内置代理也连不上时同样用此法**(#83 实例,现已缓解):内置 TMDB 代理曾托管在 `*.workers.dev` 域名下,该域名在部分国内网络/运营商下会被整域阻断——症状是搜索报 `All N TMDB access(es) failed: TimeoutError`(N 为通道数,未配 token 时为 1)。**现默认代理已换自定义域名 `tmdb-proxy.mediaryscout.app`,绝大多数国内网络可直连**;若你的网络连它也阻断,再按上面配 `HTTP_PROXY` / `HTTPS_PROXY` 让容器出站走代理。
  - **WSL2 部署注意**(#83 踩坑实录):容器内的 `127.0.0.1` 指容器自身,填 Windows 宿主上的代理要用 WSL2 虚拟网卡的宿主 IP;且 Windows 防火墙常拦截来自 WSL2 虚拟网卡的入站连接(即使代理软件开了「允许局域网连接」),需要放行防火墙或在 WSL2 内起一层转发(监听 0.0.0.0 转发到 127.0.0.1:代理端口),容器再指向 WSL2 自身 IP。
- **Prowlarr**(设置 → 资源提供商):接入索引器聚合,磁力与 PanSou 结果合并,走 115 的离线下载落盘(夸克没有可用的磁力接口)。
- **换 PanSou 实例**(设置 → 资源提供商):默认用 compose 自带的;想指向别的实例/公共域名在此手填。

## 访问方式

默认 web 只监听宿主机的 `:3000`。在同一局域网内，用手机 / 电脑 / 电视浏览器打开 `http://<宿主局域网IP>:3000` 即可。

本项目不提供公网访问能力。**不要把 `:3000` 直接暴露到公网**；如果自行通过反向代理等方式暴露，访问控制由你自己负责。

## 安全

- 本项目只走**自部署**,作者不托管(见 [distribution-and-legal-positioning.md](distribution-and-legal-positioning.md))。默认单用户、无登录。
- **只在本机 / 局域网使用,不要把 `:3000` 暴露到公网。** 多用户登录只为隔离数据,不是公网门禁。
- 想多人合用同一实例(各绑各的网盘、各看各的库):设环境变量 `MEDIA_TRACK_MULTI_USER=1` 开多用户模式(出注册 / 登录页)。

## 多用户与忘记密码

默认单用户、无登录。想让家人 / 朋友合用同一台实例(各绑各的网盘、各看各的库、互相看不见):

1. 设环境变量 **`MEDIA_TRACK_MULTI_USER=1`** 并重启 web(`docker compose up -d web`)。
2. 第一个打开站点的人会看到**认领屏**:设个用户名 + 密码即成**站主**。
   - 如果这台实例**之前已经是单用户、有媒体库了**,认领会**原样接管**现有的库和网盘——不会丢。
3. 之后每个人各自在登录页**注册**自己的账号、连各自的 115 / 夸克。

**忘记密码怎么办**(本项目不发邮件,无需配 SMTP):

- **普通用户忘了** → 找**站主**,在「设置 → 账号管理」里一键给他重置密码(不影响他的网盘和媒体库)。
- **站主自己忘了** → 在宿主机上跑(谁能进这台机器谁就能找回):

  ```bash
  docker compose exec web node scripts/reset-password.mjs <用户名> [新密码]
  ```

  不给新密码就随机生成并打印。登录后到「设置 → 修改密码」改成你自己的。

多用户登录只为隔离用户数据,不是公网门禁;不要把实例直接暴露到公网。

## 国内构建加速(Docker Hub 常年不稳定)

Docker Hub 和 ghcr 在国内常年不稳定,首次 `docker compose up` 构建 / 拉取会卡住。下面的镜像加速**只解决 Docker Hub**(占绝大多数镜像);来自 ghcr 的 `pansou` 是例外,见本节末尾。典型报错(任一即是此问题):

```
failed to fetch oauth token: Post "https://auth.docker.io/token": ... i/o timeout
DeadlineExceeded / dial tcp ...:443: i/o timeout
```

解决办法是**给 Docker 配一个国内 registry 镜像**。按你的平台来 —— ⚠️ 两者方式不同,别搞混:

**Docker Desktop(macOS / Windows)** — 不是改 `daemon.json` 文件、也没有 `systemctl`:
1. 打开 **Settings(设置)→ Docker Engine**;
2. 在那段 JSON 里加上 `registry-mirrors`(和已有字段并列):
   ```json
   {
     "registry-mirrors": ["https://docker.1ms.run"]
   }
   ```
3. **Apply & Restart**(应用并重启),等鲸鱼图标变绿再重试 `docker compose up -d`。

**Linux(含软路由 / NAS,直接装的 Docker Engine)**:把镜像写进 `/etc/docker/daemon.json` 的 `registry-mirrors`,然后 `sudo systemctl restart docker`:
```json
{ "registry-mirrors": ["https://docker.1ms.run"] }
```

**npm 也慢的话**,构建时换国内源:
```bash
docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
```

> 镜像地址会失效/限速,`docker.1ms.run` 只是示例;搜「Docker 镜像加速 可用」找当前能用的即可。配好后,所有 **Docker Hub** 镜像(`postgres`、构建 web 用的 `node`)都会走镜像 —— 本仓库 Dockerfile 已**特意不写 `# syntax=` 指令**,避免它绕过镜像、第一步就卡死(见 #46)。

**⚠️ 注意 `pansou` 例外**:它来自 **ghcr.io**(`ghcr.io/fish2018/pansou-web`),而 Docker 的 `registry-mirrors` **只对 Docker Hub 生效、管不到 ghcr**。若 ghcr 也连不上,二选一:
- 在 `.env` 设 `PANSOU_IMAGE=` 指向一个 ghcr 镜像/代理(如 `ghcr.nju.edu.cn/fish2018/pansou-web:latest`,镜像可用性自行确认),再 `docker compose up -d`;
- 或者不用自带 pansou —— 把 `PANSOU_BASE_URL` 指到一个外部 PanSou 实例,然后 `docker compose up -d web`(不起 pansou 容器)。

作者实测在带镜像加速的软路由(iStoreOS)上一把过。

## 升级

```bash
./scripts/deploy.sh
```

`scripts/deploy.sh` 会 `git pull` → 重建 `web` → `up -d` → **验证跑起来的容器确实是刚拉取的 commit**(读容器内 `BUILD_COMMIT` 和 `HEAD` 比对,不一致直接报错退出)。等价于 `docker compose up -d --build`,但多了那道**自校验**,并且不用 `--no-cache`。

> **为什么要自校验?** 升级最阴的失败是**静默回退**:`git pull` 之后容器仍在跑**旧代码**,而所有常规信号都在骗你——宿主 `git rev-parse HEAD` 显示的是新 commit(和容器里实际跑的代码无关),盯镜像 hash 也没用(`--no-cache` 重建每次 hash 都不同,纯粹是构建不确定性)。#88–#98 就是这样连续五次「部署成功」实则一整天跑旧代码。所以真正的护栏不是缓存技巧,而是**一道检查**:把镜像构建时刻的 commit 盖进 `BUILD_COMMIT`,部署后比对运行容器的 `BUILD_COMMIT` 是否等于 `HEAD`,不等就报错——无论病根是构建缓存、`git pull` 空转、还是容器没被重建,都会当场暴露而非静默溜过。
>
> `deploy.sh` 顺带传 `GIT_SHA=$(git rev-parse HEAD)` 作构建参数,Dockerfile 用它在 `COPY . .` 前触发缓存失效(ARG 在**首次使用**时 cache-miss,连带其后各层重建),每换 commit 强制重传源码 + 重建,而慢的 `npm ci` 依赖层仍走缓存。**不必 `--no-cache`**(那会把依赖层也丢掉,慢几分钟)。装了 buildx / 用内置 BuildKit 的宿主本就内容寻址、`COPY` 可靠,这层主要是给用**经典构建器**(`DOCKER_BUILDKIT=0` 或很老的 Docker)的自部署者兜底;两种构建器下都正确无副作用。
>
> 手动等价执行 + 校验:
> ```bash
> # 如果部署目录停在某个发布标签上,pull 需要一个分支(deploy.sh 自己也会先做这一步):
> git checkout main
> git pull --ff-only
> GIT_SHA=$(git rev-parse HEAD) docker compose up -d --build
> # 核对容器真在跑新代码(应等于上面的 HEAD):
> docker compose exec web cat BUILD_COMMIT
> ```

## 备份与恢复（pgdata）

自托管时 Postgres 数据在 compose 卷 `pgdata` 里，是媒体库/追踪状态的唯一真相。建议定期备份：

```bash
# 在仓库根目录
./scripts/pg-backup.sh ./backups
# → backups/mediatrack-YYYYMMDD-HHMMSS.sql.gz
```

恢复（会覆盖当前库内容，先停写入/worker）：

```bash
gunzip -c backups/mediatrack-YYYYMMDD-HHMMSS.sql.gz \
  | docker compose exec -T postgres psql -U mediatrack -d mediatrack
```

也可直接备份 Docker 卷目录（停库后拷贝），但逻辑备份（pg_dump）更便携。

### 定时备份（host crontab 示例）

在部署机用户 crontab 里加一行即可（路径改成你的仓库目录）：

```cron
# 每天 03:30 备份 pgdata；保留最近 14 天
# 若要固定北京时间，在 crontab 顶部加: TZ=Asia/Shanghai
30 3 * * * cd /path/to/mediary-scout && ./scripts/pg-backup.sh ./backups >>./backups/cron.log 2>&1
0 4 * * * find /path/to/mediary-scout/backups -name 'mediatrack-*.sql.gz' -mtime +14 -delete
```

把 `backups/` 目录同步到机外（对象存储 / NAS / 另一台机器）再算真正有备份。

