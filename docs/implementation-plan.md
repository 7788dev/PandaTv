# Panda 生产实现清单与技术选型

日期：2026-11-16。本文保留立项时的选型和里程碑，不描述现版仓库。当时尚无生产源码、根 `package.json` 和提交；现在 Windows 与原生 Android TV 分别实现。历史输入：[界面](ui-audit.md)、[豆瓣](douban-audit.md)、[播放](playback-audit.md)；冻结设计见 [SHA-256 基线](evidence/design-original-sha256.json)。现版入口见[交付报告](delivery-report.md)与[证据核验](ui-evidence-review.md)。

## 选型

| 层 | 选择 | 理由与代价 |
| --- | --- | --- |
| 桌面与后端 | Electron 45稳定版、Node、TypeScript 5.9 | Windows视频解码/窗口与Playwright桌面测试成熟；契约可前后端共享。相比Tauri体积较大，但不新增Rust实现与WebView2差异。维护期内固定版本，锁文件可复现。 |
| 界面 | React 19、Base UI 1.9、现有设计CSS/字体/图标 | 原型明确预留Base UI状态属性；无样式可访问控件不替换设计语言。独立组件和轻量hash路由，不沿用HTML字符串与演示事件委托。 |
| 视频 | 原生HTMLVideoElement + hls.js 1.7 | 设计已有全部播放器外观，不需叠加带皮肤播放器；真实时间轴、缓冲与画质轨道。 |
| 构建 | electron-vite 6、Vite 7、electron-builder 26 NSIS | 主进程/preload/renderer独立构建，稳定工具链与Windows安装卸载；不用实验性打包方案。 |
| 验证 | Vitest、Playwright Electron、真实API重放 | 纯规则/网络与真实桌面分层验证。测试fixture仅在tests/e2e，不能进入发行包。 |

上述核心库为MIT/BSD宽松许可证；字体为OFL；保留Lucide和复用见界配置的MIT署名。发行前生成依赖许可证清单。当前未提供签名证书/更新发布服务，不能伪造签名或“最新版本”结果。

## 架构与边界

`renderer React → 固定类型preload方法 → Electron main → 豆瓣适配/影视源解析/缓存/不透明媒体代理`。

- `src/shared/api.ts`引用原始契约，只补生产桥接和窗口/持久化能力。
- `src/main/data/`独立实现官方接口、校验、归一化、节流、重试、缓存；原始响应不进UI。
- `src/main/playback/`复用经过复核的源配置，精确作品/年份/类型匹配，提供availability和resolve，全部上游URL/请求头留main。
- 本地loopback服务仅发随机不透明资源句柄，图片/HLS/分片/KEY/MAP/MP4 Range统一代理；校验公网目的地址、重定向与DNS，禁转发Set-Cookie。
- 主进程原子文件持久化收藏、历史、最近搜索、设置；渲染器订阅镜像。首次启动为空。保留真实元数据供离线片单使用，并暴露错误状态。
- sandbox/contextIsolation开启、nodeIntegration关闭、验证IPC来源与输入、阻止未知导航/窗口。主进程处理窗口最小化、最大化、关闭、全屏和退出前保存。
- design目录只读引入contract/styles/copy/brand/icons；mock/art/preview/tools绝不打包。

## 编码里程碑与验收

- [x] 审阅全部原型脚本、CSS、19张截图、契约、素材、构建与见界参考链路；形成清单。
- [x] 建立工程、固定IPC、窗口/更新服务与持久化；安全与状态测试。证据：[state.test.ts](../tests/state.test.ts)、[startup.spec.ts](../e2e/startup.spec.ts)。
- [x] 豆瓣home/filter/channel/detail/related/byIds/search/suggest真实接入；字段/分页/错误/缓存测试。影视热搜改用百度电影/电视剧榜。证据：[豆瓣审阅](douban-audit.md)、[data.test.ts](../tests/data.test.ts)、[data.spec.ts](../e2e/data.spec.ts)、[筛选词表实测](evidence/filter-vocabulary.json)。
- [x] 播放源精确检索、可播集数、HLS/MP4代理；去广告规则 v2 与回归测试。证据：[播放审阅](playback-audit.md)、[去广告线上审计](evidence/ad-audit.json)、[片源覆盖实测](evidence/source-coverage.json)。
- [x] 首页、五频道、详情、搜索、收藏、历史、设置、全部浮层与状态还原。证据：[fixture.spec.ts](../e2e/fixture.spec.ts)、[界面审阅](ui-audit.md)。
- [x] 真实播放器播放/暂停/缓冲/进度/音量/倍速/可用画质/选集/全屏/画中画/下一集/错误重试，历史节流和退出刷新。证据：[live.spec.ts](../e2e/live.spec.ts)、[player-model.test.ts](../tests/player-model.test.ts)。
- [x] 类型检查、离线单测、Electron E2E、真实API与真实视频起播/拖动/切集、重启持久化、离线/错误/空态/加载态验证。结果见[交付报告](delivery-report.md)。
- [x] 当时做过原型/fixture 单一视口的[截图与几何对照](evidence/visual/overlay-report.json)。旧对照已退役，不是现版交互验收。
- [x] 生产构建、NSIS安装包、实际安装启动、打包内容检查、设计SHA256不变、交付报告。证据：[install.txt](evidence/install.txt)、[交付报告](delivery-report.md)。

## 已确认冲突的最小处理

具体依据见界面审阅。可播集数来自CMS，豆瓣总集数仅作metadata；画质按真实轨道；无片头标记不显示跳过；不把下一集的duration伪造为上一集时长。未确认热搜不返回假词；缺少更新URL时短错误反馈。原型未附手册/工具缺失脚本以现存CSS+contract+reference为准。

## 验证后仍然成立的限制

早期验证覆盖过热搜、广告片段、部分不可达/错片源与一次实际安装。未逐一验证所有数据组合、设备、DPI 或长时播放；外部接口无可用性承诺。各版本以自己的采样结果为准。

## 2026-11-16 接续复核

现有骨架基线见 [实际结果](evidence/baseline-2026-11-16.txt)。重新核对全部19张状态截图、契约、CSS与现有生产结构后继续实现。用户追加完整细分类筛选要求；总体取舍与备选项目（LibreTV、LunaTV、DailyHotApi 等）的比较见[决策记录](../.agents/notes/implemented/architecture/2026-11-16-production-completion.md)，细分决定见同目录其余记录。
