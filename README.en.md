<p align="center">
  <img src="docs/images/hero.svg" alt="Mediary Scout" width="600">
</p>

<p align="center">
  <b>An agent-driven media library for your own cloud drives.</b>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/fancydirty/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest"><img src="https://img.shields.io/github/v/release/fancydirty/mediary-scout?display_name=tag" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="https://github.com/fancydirty/mediary-scout/releases/latest">📥 Download</a> ·
  <a href="https://mediaryscout.app/en/">🌐 Website</a> ·
  <a href="https://demo.mediaryscout.app">🔭 Live demo</a> ·
  <a href="README.md">中文</a>
</p>

Ask for a movie, show or anime; an agent searches for it, transfers the best match into your own drive (115 / Quark), reads the drive back to confirm it landed, and keeps filling in episodes that are still missing. Episodes and films already in Emby are not searched again; after landing, SmartStrm can be told to generate `.strm` files.

Support the author: [buy me a coffee](docs/support/README.md)

Community: this project takes part in and endorses the [LINUX DO community](https://linux.do), where many users self-host, share drive tips, and get deployment questions answered fast. [![认可 LINUX DO](https://img.shields.io/badge/LINUX%20DO-认可-2ecc71?style=flat&labelColor=1f1f1f)](https://linux.do)

![Mediary Scout: search a title, hit 获取, and the agent searches, transfers, and verifies it into your drive](docs/images/demo.gif)

## Install (Docker)

```bash
git clone https://github.com/fancydirty/mediary-scout && cd mediary-scout
docker compose up -d
```

Open `http://<host>:3000`, connect a drive and add an AI model in Settings, then search a title and hit 获取. Upgrade by running `./scripts/deploy.sh` in the deployment directory. Build mirrors for mainland China, multi-user, backups, and a prompt that lets an AI agent deploy it for you are all in the **[deploy guide](docs/deploy.md)** (Chinese).

Bringing your own OpenAI-compatible AI model endpoint is an optional upgrade (the key stays in your own instance). Without a configured AI model, the app defaults to Kilo Code's free public model pool (no signup needed; the acquisition conversation context - search queries, task and message content, candidate results, file names - is sent to Kilo and its upstream model providers). Metadata works out of the box. Resource search uses PanSou: the bundled instance works out of the box and can be swapped for your own in Settings; Prowlarr can be added for magnets.

## Supported drives

When multiple drives are connected, the agent unifies all drive pools, checks live free space before every transfer, and can even complete a single season across multiple drives ([Multi-Drive Agent overview](https://mediaryscout.app/features/multi-drive-agent/)):

- **Quark**: share-link transfer; QR login; the largest pool on PanSou.
- **115**: share links + magnets; QR login.

## Library & automation

- **Four shelves**: movies / TV / variety / anime land in separate trees. Each drive can customise its root name, the four shelf names, and the mount prefix SmartStrm sees.
- **Emby integration**: titles already in Emby are matched by TMDB id and never searched again; one Emby library scan is triggered after a run lands files. Library names are configurable.
- **SmartStrm automation webhook**: after landing, an `a_task` is sent per directory. Landings in the same directory are merged during a quiet window (15s default, 120s max wait); HMAC-SHA256 signatures, retries, a delivery log and a test button are built in. Paths include the drive's SmartStrm mount prefix.

## More docs

- [Official Website (English)](https://mediaryscout.app/en/) · [Guides & Tutorials Hub](https://mediaryscout.app/guides/) · [Mediary Scout vs. MoviePilot / Sonarr](https://mediaryscout.app/compare/mediary-scout-vs-moviepilot-sonarr/)
- [Deploy guide](https://mediaryscout.app/guides/docker-nas-deploy/) ([repo docs](docs/deploy.md))
- [Agent API](https://mediaryscout.app/features/agent-api/) ([repo docs](docs/agent-api.md)): let coding agents such as Claude Code, Codex, or OpenClaw drive Mediary Scout
- [Smart Search & Subtitles](https://mediaryscout.app/features/smart-search-and-subtitles/) · [Search and web research](docs/web-research.md) (Chinese): describe a plot, or how shows without official seasons map to episode numbers
- [Architecture overview](docs/architecture.md)

## Disclaimer

Mediary Scout is open-source, self-hosted software. It is not offered, and never will be offered, as a hosted service: you run your own instance and bring your own drive and AI model credentials. It performs the same file operations you could do by hand in your own cloud drive. See [project positioning](docs/distribution-and-legal-positioning.md). Not affiliated with 115, Quark, TMDB, Emby, SmartStrm, or any indexer.

## Credits

- [PanSou](https://github.com/fish2018/pansou-web): resource search backend
- [Prowlarr](https://github.com/Prowlarr/Prowlarr): indexer manager (optional)
- [p115client](https://github.com/ChenyangGao/p115client): 115 API reference
- SmartStrm: `.strm` generation and the `a_task` webhook contract
- [TMDB](https://www.themoviedb.org/): metadata (this product is not endorsed or certified by TMDB)

## Star History
<a href="https://www.star-history.com/?repos=fancydirty%2Fmediary-scout&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&theme=dark&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
    <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=fancydirty/mediary-scout&type=date&legend=top-left&sealed_token=SyhZxdVgoG8rffU_0ypYi7eroHlPNo9kj1V0_4F2L1vJ_C_Yw_DBBmDqGADi7kl916TTZJ8nmCCIK6osu_tfo__vf8AfSlwqk176hnpqc_oIg_PcmKuulA" />
  </picture>
</a>
