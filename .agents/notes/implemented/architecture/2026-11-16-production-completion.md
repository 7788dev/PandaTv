# Agent Note: 桌面链路与数据来源的总体取舍

Status: implemented

（原为提案，验收项全部完成后于 2026-11-16 转为已实施；细分决定各有单独记录。）

## Problem

仓库里有高保真原型和一份生产骨架：类型检查不过，桌面入口和播放器缺失，筛选只有少量分类，豆瓣没有可用的影视热搜端点。需要在不改动原型的前提下交付可安装、真实可播的 Windows 应用。

## Decision

- 架构沿用[实现清单](../../../../docs/implementation-plan.md)：`renderer React → 类型化 preload → Electron main → 豆瓣适配 / 片源解析 / 缓存 / 不透明媒体代理`；网络、凭据、规则全部留在主进程。
- 影视元数据只用豆瓣官方无凭据接口（recommend / search / detail / celebrities / photos / recommendations）；细分筛选用豆瓣标签交集，见[筛选词表](2026-11-16-filter-vocabulary.md)。
- 热搜用百度电影榜与电视剧榜的官方 JSON（[hot-search.ts](../../../../src/main/data/hot-search.ts)，校验榜单标识与“热搜指数”字段），因为豆瓣的候选端点返回 404 或只有全站话题。
- 片源与去广告见[身份匹配](2026-11-16-source-identity.md)、[去广告证据](2026-11-16-ad-evidence.md)、[媒体端口](2026-11-16-media-ports.md)；安装包见[打包](2026-11-16-packaging.md)。

## Alternatives considered

- LunaTV 的公开代理配置：多一个故障点；其 README 标注 CC BY-NC-SA 4.0，不复制源码。
- LibreTV / DailyHotApi / 60s 等公益实例：可借鉴端点发现方式，但实例限流且不覆盖完整豆瓣详情；直接请求已验证的官方接口依赖更少。
- TMDB / TVmaze 取代豆瓣做主库：前者需要独立凭据，后者华语覆盖有限，也无法保留统一的豆瓣身份去匹配片源。
- 把全部年份平铺在筛选区：会把片单挤出首屏；改为默认三行、展开后给出全部可查询年份。
- 把豆瓣热门电影榜当作“热搜”：那是评分/热度榜，不是搜索词。

## Consequences

豆瓣、百度榜单与播放源都没有可用性承诺；限流、重试、缓存、熔断和多源竞速只能降低故障影响，没有真实数据时界面显示错误与重试而不是占位内容。没有发布服务与签名证书：应用内“检查更新”在未配置 `PANDA_UPDATE_URL` 时明确反馈不可用，安装包未签名。验收证据的入口是[交付报告](../../../../docs/delivery-report.md)。
