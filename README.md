<p align="center">
  <img src="docs/images/hero.svg" alt="巡影 · Mediary Scout" width="600">
</p>

<p align="center">
  <b>巡影 · Mediary Scout</b><br>
  <b>给你自己网盘用的 agent 驱动媒体库。</b>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest"><img src="https://img.shields.io/github/v/release/fancydirty/mediary-scout?display_name=tag" alt="最新版本"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest">📥 下载</a> ·
  <a href="https://mediaryscout.app">🌐 官网</a> ·
  <a href="https://demo.mediaryscout.app">🔭 在线 Demo</a> ·
  <a href="README.en.md">English</a>
</p>

你说要哪部电影、剧或番，agent 自己去搜资源，挑最合适的转存进你自己的网盘（115 / 夸克），转完读回来确认真的到了，之后缺哪集还会接着补。已经在你 Emby 里的集不会再搜；落盘后还能自动通知 SmartStrm 生成 `.strm`。

点击前往赏饭：[要饭嘛，不寒碜](docs/support/README.md)

交流：本项目积极参与并认可 [LINUX DO 社区](https://linux.do)，许多用户在那里自部署、交流网盘经验，部署问题也能很快得到回应。 [![认可 LINUX DO](https://img.shields.io/badge/LINUX%20DO-认可-2ecc71?style=flat&labelColor=1f1f1f)](https://linux.do)

![巡影：搜片 → 点获取 → agent 自动搜索、转存、验证落进你的网盘](docs/images/demo.gif)

## 安装（Docker）

```bash
git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout
docker compose up -d
```

打开 `http://<主机IP>:3000`，在设置里连网盘、填 AI 模型 → 搜片点「获取」。升级时在部署目录运行 `./scripts/deploy.sh`。国内构建加速、多用户、备份，以及让 AI agent 替你部署的提示词，都在 **[部署指南](docs/deploy.md)**。

自带 OpenAI 兼容的 AI 模型接口是可选升级（key 只存在你自己的实例里）。未配置 AI 模型时，默认使用 Kilo Code 的公共免费模型池（无需注册；获取任务的对话上下文——搜索查询、任务与留言内容、候选结果、文件名等——会发送给 Kilo 及其上游模型提供商）。影视信息开箱即用。资源搜索用 PanSou：容器自带的实例开箱即用，可以在设置里换成你自己的；可选再接 Prowlarr 找磁力。

## 支持的网盘

连接多个网盘时，agent 会自动联合各盘资源池并按实时剩余容量与画质分配落盘，也可以跨盘凑齐同一季（[多网盘联合获取详解](https://mediaryscout.app/features/multi-drive-agent/)）：

- **夸克**：分享链转存，扫码登录，PanSou 上资源最多。
- **115**：分享链 + 磁力，扫码登录。

## 媒体库与自动化

- **四类媒体库**：电影 / 电视剧 / 综艺 / 动漫分别落到独立目录；每个网盘都能自定义根目录（支持多级，如 `影音/影视`）、四个分类目录名，以及它在 SmartStrm 里的挂载前缀。
- **Emby 联动**：按 TMDB id 识别 Emby 里已有的集和电影，已有的不再搜索；落盘后触发一次 Emby 媒体库扫描。媒体库名称可在设置里改成你实际用的名字。
- **SmartStrm 自动化 Webhook**：文件落到夸克后按目录发送 `a_task`，同一目录在静默期（默认 15 秒，最长等待 120 秒）内合并为一次扫描；支持 HMAC-SHA256 签名、失败重试、投递日志和测试按钮。路径会自动带上该盘的 SmartStrm 挂载前缀。115 由 Emby 直接挂载，不触发 STRM 刷新。

## 更多文档

- [官网指南中心](https://mediaryscout.app/guides/)：[NAS / Docker 部署教程](https://mediaryscout.app/guides/docker-nas-deploy/) · [网盘与搜索源配置](https://mediaryscout.app/guides/cloud-drive-setup/) · [与 MoviePilot / Sonarr 对比](https://mediaryscout.app/compare/mediary-scout-vs-moviepilot-sonarr/)
- [部署指南](docs/deploy.md)
- [Agent API](https://mediaryscout.app/features/agent-api/)（[仓库文档](docs/agent-api.md)）：让 Claude Code、Codex、OpenClaw 等 agent 直接操作巡影
- [AI 选源与外挂字幕](https://mediaryscout.app/features/smart-search-and-subtitles/) · [搜索与网页查证](docs/web-research.md)：描述也能找片；官方不分季的作品怎么对集号
- [架构速览](docs/architecture.md)

## 免责声明

巡影是开源、自部署的软件，不提供、也永远不会提供托管服务：你自己跑实例，自带网盘和 AI 模型的凭证。它做的就是你本可以在自己网盘里手动完成的那些文件操作。详见[项目定位](docs/distribution-and-legal-positioning.md)。与 115、夸克、TMDB、Emby、SmartStrm 及任何索引器均无隶属关系。

## 致谢

- [PanSou](https://github.com/fish2018/pansou-web)：资源搜索后端
- [Prowlarr](https://github.com/Prowlarr/Prowlarr)：索引器管理（可选）
- [p115client](https://github.com/ChenyangGao/p115client)：115 API 参考
- SmartStrm：`.strm` 生成与 Webhook `a_task` 约定
- [TMDB](https://www.themoviedb.org/)：影视元数据（本产品未获 TMDB 认证或背书）

## Star History
<a href="https://www.star-history.com/?repos=fancydirty%2Fmediary-scout&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&theme=dark&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
  </picture>
</a>
