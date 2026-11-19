# Agent Note: Android TV 原生客户端（面向 Android 5.1 与 10 英尺遥控器交互）

Status: implemented

## Problem

客厅电视型号为 TCL L55P2-UD：出厂系统 Android 5.1（API 22），晶晨 T968 四核 Cortex-A53 处理器，1.5 GB 内存（Android 5.1 下 Bitmap 像素直接占受管 Java 堆，单应用堆上限通常 96–128 MB），8 GB 闪存（可用空间紧缺），55 英寸电视屏幕仅靠遥控器方向键操作。桌面端的 Electron + React 19 方案无法运行在电视上，而老系统的系统根证书库停留在 2015 年前后（缺少 ISRG Root X1 等现代根证书），内置 WebView 版本老旧且不支持 `@layer`、`:has()` 等现代特性；用户明确要求安装包与运行占用都不要太大，并针对电视端交互和组件间距做专门适配。

## Decision

在 [tv/](../../../../tv/) 下用原生 Kotlin + Android Views 构建独立电视端应用；版本、产物和验收由[交付报告](../../../../docs/delivery-report.md)记录：

- **底层框架与体积控制**：不引入 WebView、JS 引擎、跨端运行时或任何 `.so` 原生库（天然无 ABI 体积膨胀，兼容 32/64 位 ARM 与模拟器 x86_64）。构建采用 AGP 9.5.0 + Gradle 9.7.1，`minSdk = 22`、`targetSdk = 34`；播放器锁定支持 API 22 的最后一代 Media3 `1.8.1`（`media3-exoplayer` + `media3-exoplayer-hls`，Media3 1.9.0 起已将 `minSdk` 升至 23），不引 `media3-ui`，自绘 `SurfaceView` 与遥控器播控层；焦点网格使用 `androidx.leanback:leanback-grid:1.0.0`（`HorizontalGridView` / `VerticalGridView`），并固定 `androidx.core:1.13.1`、`recyclerview:1.3.2` 等依赖使整条依赖树 `minSdk <= 22`。开启 R8 代码压缩、资源压缩与 `localeFilters("zh", "zh-rCN")`，剥离 80 余套外语文案与商店元数据，启用 v1（JAR，Android 7.0 以下必需）+ v2 双签名。正式包为单 DEX，0 个原生库；当前体积与版本以[交付报告](../../../../docs/delivery-report.md)为准。
- **Android 5.1 网络、内存与闪存适配**：
  - TLS 与根证书（[TlsCompat.kt](../../../../tv/app/src/main/java/app/panda/tv/net/TlsCompat.kt)）：随包内置当前 Mozilla 根证书束（`assets/cacerts.pem`，140+ 根证书）与系统 TrustManager 组合校验，在不包裹底层 Conscrypt `SSLSocket`（保留反射式 SNI 设置）的前提下启用 TLS 1.2；应用启动时在后台线程异步初始化证书库，避免在 Cortex-A53 主线程阻塞冷启动首帧。
  - 内存、闪存与滚动帧率优化：针对 API 22 Bitmap 占用 Java 堆的特点，海报统一按目标像素做 `inSampleSize` 降采样并以 `RGB_565` 解码（圆形顶对齐头像用 `ARGB_8888`），复用 `ThreadLocal` 解码缓冲，限制并发解码（`Semaphore(3)`）并在卡片回收时立即取消陈旧图片任务，无锁读取磁盘缓存且每 24 次写入才触发一次淘汰扫描；预热缓存 `WarmMediaCache` 上限收紧至 8 MB，首片 `.ts` 在 ExoPlayer 读取后立即释放堆内存，仅保留清单与密钥；`ExoPlayer` 的 `DefaultLoadControl` 在小堆设备（`<= 192 MB`）自动收紧缓冲上限至 16 MB / 24 秒；磁盘海报缓存封顶 36 MB、元数据缓存封顶 4 MB / 1200 条；`FixedSizeImageView` 关闭重叠渲染层（`hasOverlappingRendering = false`）并抑制固定宽高下的重复 `requestLayout()`；焦点缩放关闭动态阴影轮廓（`outlineProvider = null`），采用 `DecelerateInterpolator` 首帧瞬时响应，并在长按方向键高速连滚时自动跳过中间过渡动画；网格关闭 `ItemAnimator`、调优 `smoothScrollSpeedFactor` 与增量分页（`notifyItemRangeInserted`）。
- **桌面端逻辑 1:1 移植与黄金向量校验**：豆瓣数据归一化、738 项筛选词表、残缺页重读与拆小页、主要演职员（`credits`）与影人全部作品、百度影视热搜、9 个片源并发检索、名称+年份+分类身份匹配、长篇连载集数区间映射、首片 H.264 SPS 实际分辨率解析与三源并发竞速、基于清单内证据的 HLS 去广告（在 [PandaMediaDataSource.kt](../../../../tv/app/src/main/java/app/panda/tv/playback/PandaMediaDataSource.kt) 读取清单时直接过滤并绝对化地址，省去本机 HTTP 代理端口开销）全部移植至 Kotlin。由 [export-tv-vectors.ts](../../../../scripts/export-tv-vectors.ts) 从桌面端 TypeScript 真源导出黄金测试向量（`golden-vectors.json`），Kotlin 单测逐项断言双端输出一致。
- **10 英尺电视视口与遥控器交互设计**：
  - 视口比例锁定与防溢出布局（[Theme.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/Theme.kt)）：采用以 `960×540` 为基准的屏幕实际像素比例单位（`minOf(screenW / 960f, screenH / 540f)`）与 `COMPLEX_UNIT_PX` 字号，兼容国产电视非标系统 DPI（如 `240dpi` / `480dpi`）与系统大字体缩放而不发生布局缩小或越界溢出。全局统一 `4.8%` 安全边距导轨（1080p 下左右各 `92px`），横向卡片行与标签栏封装在安全边距裁剪框（`framedHorizontalRow`）内，保留边缘焦点光环余量的同时杜绝屏幕边缘半截溢出；滚动内容区开启硬件裁剪（`clipChildren = true`）并通过 `HeaderFirstLinearLayout` 保证顶栏与二级筛选抽屉始终绘制在滚动网格上方，绝不嵌到海报下方。
  - 首页纵向 `VerticalGridView` 与轮播图回顶（[HomeScreen.kt](../../../../tv/app/src/main/java/app/panda/tv/ui/HomeScreen.kt)）：首页由单列 Leanback `VerticalGridView`（`focusOutFront = false`）承载主推轮播与各横向栏目并共享 `RecycledViewPool`；从下方任意栏目按上键必定先回到第 0 项轮播图并完整对齐到顶部，再次按上键才进入悬浮胶囊顶栏。
  - 单一焦点环与原生电视细节：严格区分 `state_focused`（2dp 高亮竹青光标环 + 微放大）与未获焦的 `state_selected`（柔和浅底 + 1dp 细边）；居中卡片式加载态；3×13 遥控器快捷输入面板、搜索结果分类筛选、返回键收起筛选抽屉、全屏连续左右快进锚定进度条、线路面板默认聚焦在播源。

历史实测（1.0.1，2026-11-18 14:54–15:03，[tv-verification.json](../../../../docs/evidence/tv-verification.json)，截图在 `docs/evidence/runtime/tv/`；以下帧率和起播时间不作为新包的测量值）：
- 构建与静态检查：`testDebugUnitTest` 12 项通过（含黄金向量对齐与缓存释放测试）；`lintRelease` 通过且 `NewApi`（fatal）0 错误；APK 1,061,874 字节（`1.0.1`，2026-11-18 15:22 构建），SHA-256 `169528E819EC0410E4AB5B0C091CFDED87D8D56F30C6511E47194B9B77AA8BC8`。
- MuMu 模拟器（Android 15，`1920×1080 @ 320dpi` 及 `240dpi` / `480dpi` 多密度回归）全流程遥控器 E2E：加载提示严格水平居中（`cx = 959px`）；首页下滚至榜单与电影后连续按上键 100% 完整回到轮播图（`playCy: 559px → 559px`），首页与频道连续滚动 `gfxinfo` **0 掉帧（`jankyFrames = 0`，首页 `p95 = 5ms`、频道带二级筛选连滚 `p95 = 10ms`）**；展开二级筛选上下快速滚动时卡片严格裁剪在筛选栏下方（`chipBottom = 306px`，`minCardTop = 332px`）；`240dpi` / `320dpi` / `480dpi` 全控件零越界（`maxRight = 1828px`）；搜索《三体》→ 详情页 8 位主要演职员 → 于和伟“全部作品”页无截断 → 真实起播《三体》第 1 集 1.10 秒出画面并现场过滤量子 14 段 51.52 秒广告，全程 `AndroidRuntime` 0 崩溃。

1.0.2 增加的完整首行回顶、保持列位置与详情返回、取消陈旧查询、播放前查源、立即切集、控制层焦点和首片迟到读取修复见 [TV interaction](2026-11-18-tv-interaction.md)。双端自动选源的播放余量规则由 [source-contest](2026-11-17-source-contest.md)维护。

## Alternatives considered

- **WebView / Capacitor 套壳桌面渲染器**：Android 5.1 出厂系统 WebView 为 Chromium 37–40 年代且国内电视 ROM 通常无法独立升级，不支持桌面端依赖的 CSS `@layer`、`:has()` 与现代 ES 特性；若自带 Crosswalk / GeckoView 内核，仅内核体积即达 35–60 MB，违背小体积与低内存要求。
- **React Native / Flutter**：自带引擎与运行时动态库，单/双架构最小正式包通常 12–25 MB 以上，且新版 Flutter 与 RN 已放弃 API 21/22 支持，1.5 GB 内存电视上冷启动与焦点延迟明显劣于原生 View。
- **Jetpack Compose for TV（`androidx.tv:tv-material`）**：当前 AndroidX Compose 系列默认 `minSdk` 已升至 23（Android 6.0），不支持 Android 5.1；即使强行锁定多年前旧版，Compose 运行时与首个界面的 JIT 编译开销在四核 A53 老电视上也会造成首屏与滚动掉帧。
- **内嵌 QuickJS 跑编译后的桌面 TypeScript 逻辑**：需要引入 `.so` 原生库（多 ABI 膨胀数 MB）并在每次网络/UI 交互时跨 JNI 序列化数据；直接移植约 2,500 行纯逻辑并用黄金向量单测锁死一致性，体积更小、调试栈单一且无原生库兼容风险。
- **旧版 ExoPlayer 2.19.x**：虽支持低 API，但已停止维护；Media3 `1.8.1` 官方仍支持至 API 21，HLS 分片与解码器回退实现更成熟。

## Consequences

- 桌面端修改 `design/contract/rules.ts`、`src/main/data/{normalize,taxonomy,hot-search}.ts` 或 `src/main/playback/{service,filter,picture}.ts` 的纯规则或 `resources/play-sources.json` 时，需同步更新 `tv/` 对应实现并运行 `node scripts/export-tv-vectors.mjs` 与 `tv/gradlew testDebugUnitTest` 校验双端一致。
- 开发机不具备实体 TCL L55P2-UD（Android 5.1）硬件连接，本机 HypervisorPlatform 未开启，运行时 E2E 在 MuMu（Android 15，`960×540dp` 电视视口）上完成；Android 5.1 的 API 兼容性由 `minSdk = 22` 编译约束、`lintRelease` 的 `NewApi` 致命检查、v1+v2 签名与内置根证书保障，实机解码表现仍取决于电视固件自身的 `MediaCodec` 实现（已开启解码器回退与失败自动换源兜底）。
