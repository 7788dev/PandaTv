# Panda 实际使用场景审计 · 2026-11-22

本文是 2026-11-22 的修复前审计快照。后续 D01–D07 与 A01–A04 的修复、最终候选与实际验收边界见[2026-11-23 修复报告](usage-fixes-2026-11-23.md)；以下保留当时的发现与取证。

审计时的工作区确认了 **7 项尚未修复的缺陷：3 项 P1、4 项 P2**，以及 4 项有复现依据的改进点。最先应处理 TV 的存储异常、损坏状态覆盖和请求取消传播；桌面主要问题集中在分页返回、预加载与换线、默认画质和媒体加载后的倍速。

正常浏览和短时播放链路有通过证据，问题主要出现在操作组合、异常恢复和长期使用边界。本次只分析和取证，没有修改生产源码、提交、发布、升级 Windows 安装或安装新的 APK。进入时的既有修改与未跟踪文件均保留。

## 审查对象与方法

对象是 HEAD `4220d6dff973a55f42508a49a9c0c3d43d3b296a` 上的**当前工作区**，包含此前审计的未提交修复；桌面版本 1.1.4、TV 版本 1.0.14。本文新增发现与[此前系统审计](system-audit-2026-11-22.md)分开记录。此前修复的播放进度冻结恢复、主题分类覆盖、2501-ID 读取限制和 WorkLimiter 交接问题，不再列为当前缺陷。

先复核交付报告、实现计划、原始审计和相关决策，再沿用户操作跨层检查。能执行的结论均做第二轮复验；涉及网络或设备的结果明确区分确定性输入、隐藏生产 renderer、真实 main/preload、真实网络和已安装 APK。实现解释还参考了 Context7 的 React 卸载状态、协程取消和 AGP 测试源目录文档。

| 使用环节 | 关键路径 | 本次观察 |
| --- | --- | --- |
| 启动、频道、搜索、影人、返回 | renderer → typed bridge → 主进程元数据与缓存 | 真实网络基本链路通过；深层分页返回丢失已加载内容 |
| 详情和播放准入 | 基础 subject → credits/photos → 播放解析 | 可选元数据仍阻塞主体；TV 共享详情请求的取消归属错误 |
| 换线、切集、清晰度、倍速 | 播放服务缓存 → 播放器状态 → 原生媒体 | 预加载未随手动换线失效；新画质默认值被旧会话覆盖；倍速标签与实际速率不符 |
| 收藏、历史、设置、故障恢复 | UserStore → 持久化 → 页面/播放器入口 | TV 写失败可崩溃，损坏文件会被后续操作覆盖；桌面损坏状态无有效恢复界面 |
| 大量收藏和长时间使用 | byIds、元数据预算、图片磁盘缓存 | 读取串行且整批失败；图片缓存预算只在启动清理时约束 |
| 发行与硬件适配 | 构建、设计基线、已安装 APK | 本次验证当前构建与 MuMu API 35；API 22 真机、长时播放和完整安装验收仍需补样本 |

以下时间均为 **Asia/Shanghai（UTC+8）**；原始 JSON/XML 保留各自 ISO 时间。当前源码与构建身份、命令结果、取证文件摘要见 [validation.json](evidence/usage-audit-2026-11-22/validation.json)。

## 已确认缺陷

P1 表示可导致应用退出、用户数据恢复材料丢失或有效播放操作被取消，应优先修复；P2 表示常用操作的状态或结果不符合用户选择。这里的优先级是基于影响，不代表已测得发生频率。

| ID | 级别 | 场景与实际结果 | 复验层级 |
| --- | --- | --- | --- |
| D01 | P1 | TV 保存设置遇到写权限错误，异常到达主线程并退出应用 | 相同已安装 APK、真实焦点与 D-pad，2 次 |
| D02 | P1 | TV 读取损坏用户文件默认为空状态，下一次收藏覆盖原文件 | 当前 Kotlin UserStore，2 轮 JVM 执行 |
| D03 | P1 | 旧 TV 详情请求取消，仍有效的新跟随请求也被取消 | 当前 Kotlin DoubanDataSource，2 轮 JVM 时序复现 |
| D04 | P2 | 桌面频道/影人加载 90 张卡片，详情返回只剩 30 张，原卡片不存在 | 当前生产 renderer + 隔离测试数据，双入口各 2 轮 |
| D05 | P2 | 下一集已预加载 A，手动选 B 后下一集仍直接取缓存 A | 当前 PlaybackService，2 轮确定性复现 |
| D06 | P2 | 播放器选过 480P，再把设置默认改为 720P；新影片仍请求 480P | 真实菜单操作、当前 renderer 和本地 MP4，2 轮 |
| D07 | P2 | 默认 1.5×首次加载、手动 2×后换画质，实际速率均回到 1×，标签未同步 | 新会话、原生 MP4 解码与事件/属性跟踪，2 轮 |

### D01 · TV 未处理持久化写入异常

**触发与结果。** 在已安装的最终候选 APK 上，先确认实际焦点为“自动播放下一集”，临时把 app files 目录设为只读，再按 D-pad 确认。两次都出现 `FileNotFoundException / EACCES`、`FATAL EXCEPTION: main` 和进程退出。旧状态在失败时保持不变。证据见 [设备摘要](evidence/usage-audit-2026-11-22/tv-storage-summary.json)及两次 [AndroidRuntime 日志](evidence/usage-audit-2026-11-22/tv-storage/run-1-android-runtime.log)、[第二次日志](evidence/usage-audit-2026-11-22/tv-storage/run-2-android-runtime.log)。

**原因。** [TV UserStore](../tv/app/src/main/java/app/panda/tv/state/UserStore.kt) 第 25、30、53–58 行在 dispatch 中同步写文件并直接抛出 I/O 异常；[SettingsScreen](../tv/app/src/main/java/app/panda/tv/ui/SettingsScreen.kt) 第 89 行的 UI 回调未处理失败。复核全部 TV dispatch 入口还发现播放历史保存（[PlayerScreen](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt) 第 1230 行）等调用同样缺少错误边界。设备实测的是设置入口和写权限错误；磁盘不足、其他入口的具体崩溃尚未分别回放。

**建议与验收。** 让保存失败成为可恢复结果，保持上一份有效状态，显示准确的保存失败提示；把串行写入移出 UI 主线程，并在各 UI/播放入口统一处理。对相同失败输入，应用须继续响应、设置值和旧文件保持一致，恢复写权限后重试能成功。历史保存失败也须独立回放，不能中断正在播放的视频。

### D02 · TV 损坏状态被静默重置并覆盖

**触发与结果。** 为真实 UserStore 提供包含原收藏 `db-1` 的损坏 JSON。它加载出 0 条收藏，没有隔离损坏文件；随后收藏 `db-2`，原文件被替换为仅含 `db-2` 的新状态。两轮结果一致，见 [JVM 第一轮](evidence/usage-audit-2026-11-22/tv-probes-first.xml)和[第二轮](evidence/usage-audit-2026-11-22/tv-probes-second.xml)中的 `corruptUserFileSilentlyResetsAndNextWriteReplacesIt`。测试输入为合成数据，没有损坏设备上的用户文件。

**原因。** [UserStore.kt](../tv/app/src/main/java/app/panda/tv/state/UserStore.kt) 第 39–50 行把所有读取异常都转成 `initialUserState()`，后续第 53–58 行按正常状态保存。不存在“首次使用”和“已有文件损坏”的状态区别，也没有保留原恢复材料。

**建议与验收。** 区分文件不存在、可恢复字段问题和整文件损坏；保留原文件或上一份有效备份，对损坏状态提供显式恢复操作。读取损坏文件后，再搜索、收藏或改设置均不得自动覆盖原件；正常重启和经过用户确认的重置需分别验证。

### D03 · TV 详情请求共享了错误的取消归属

**触发与结果。** 请求 A 创建同一影片的共享详情任务，请求 B 在 A 结束前加入；B 仍处于有效状态时取消 A。B 收到共享任务的 `CancellationException`，没有重新发起详情读取。另一个独立控制请求才成功读出影片。两轮均记录 `activeFollower=true`、`inheritedCancellation=true`，见上述两份 JVM XML 的 `detailFollowerInheritsCancelledLeader`。

**原因与影响。** [DoubanDataSource.kt](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt) 第 564–589 行把首个调用的异常交给共享 deferred，第 575 行的跟随者直接 `await()`。HTTP 层已有取消领导请求后让有效跟随者重试的保护，但外层 detail 没有。现有 [MetadataFlightTest](../tv/app/src/test/java/app/panda/tv/MetadataFlightTest.kt) 覆盖的是 HTTP 层。播放准入在 [MainActivity](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt) 第 378 行调用 detail，第 387–388 行重抛取消，因此该时序可结束有效准入而不产生普通错误提示；这一 UI 影响由入口精读确认，未在设备上制造该竞态。

**建议与验收。** 跟随者遇到共享任务取消时，先确认自己的协程仍有效，再重新获得或建立任务；保留用户主动取消的语义。回归须同时覆盖“旧调用取消、新调用成功”“新调用自己取消后不再发请求”“成功和普通错误仍可正常共享”。不要通过全局忽略取消来修复。

### D04 · 桌面分页数据与返回位置没有一起保存

**触发与结果。** 在频道或影人作品页加载三页，滚动并聚焦第三页的实际卡片，再进入详情并返回。两轮、两个入口都从 90 张卡片变为 30 张；频道 `scrollTop` 为 `4424 → 530`，影人为 `4292 → 538`，所选卡片已不存在。基线在辅助导航完成、实际离开页面之前采集，排除了测试 helper 自己滚动造成的误判。

数据见 [renderer 第一轮](evidence/usage-audit-2026-11-22/ui-probes-first.json)、[第二轮](evidence/usage-audit-2026-11-22/ui-probes-second.json)；频道的[离开前截图](evidence/usage-audit-2026-11-22/channel-second-before.png)与[返回后截图](evidence/usage-audit-2026-11-22/channel-second-after.png)属于**测试数据证据**，不作为真实目录或线上元数据证据。

**原因。** [pages.tsx](../src/renderer/pages.tsx) 第 99–108 行把追加分页仅存在 `PagedGrid` 的组件 state 中；进入详情会卸载它。频道和影人页都用该组件（第 140、221 行）。[App.tsx](../src/renderer/App.tsx) 第 148、153 行只保留滚动值，返回时没有相应列表高度和卡片。现有返回滚动用例 [layout.spec.ts](../e2e/layout.spec.ts) 第 175 行测试首页，未覆盖追加分页。

**建议与验收。** 按频道筛选/影人 ID 保存有界的分页快照、cursor 与离开时锚点，先恢复内容再恢复位置。三页返回须保留原卡片和滚动/焦点；修改筛选后不得混入旧结果；淘汰页面快照后须有明确的重建行为，不能无限保留页面。

### D05 · 手动换线没有使下一集预加载失效

**触发与结果。** 先把第 2 集按 A 线路预加载，再在第 1 集手动选择 B，接着请求第 2 集。它仍返回已缓存的 A 地址且没有发出新媒体探测；未预加载的第 3 集正确选择 B。两轮证据在 [data 第一轮](evidence/usage-audit-2026-11-22/data-probes-extended-first.json)、[第二轮](evidence/usage-audit-2026-11-22/data-probes-extended-second.json)的 `manual-line-choice-does-not-invalidate-prepared-next-episode`。

该复现执行真实 `PlaybackService.resolve / choose / attempts` 和缓存，仅替代目录及媒体获取，证明服务逻辑问题；它不是两个线上片源的实际接管测试。

**原因。** [service.ts](../src/main/playback/service.ts) 第 373 行的解析缓存键只有作品、集数和画质；第 375 行在检查新偏好之前返回缓存。第 432 行和第 478 行虽会读取/更新作品级 preferred，但未使已预加载集数失效。缓存有效期为 3 分钟（第 61 行）。现有 [playback-start.test.ts](../tests/playback-start.test.ts) 第 369 行验证手动选择后下一集使用同一源，但没有先预加载下一集。

**建议与验收。** 让手动线路选择推进作品的偏好版本，或精确使该作品相关解析缓存失效；晚到的旧预加载也不得重新写入有效缓存。回归须先预加载再换线，并覆盖正在进行的预加载、同画质下一集以及手动源失败后的既有回退。TV [PlaybackService.kt](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt) 第 508–529 行有类似缓存结构，应单独验证，本文不把未执行的 TV 情况算成第八项缺陷。

### D06 · 新保存的默认画质被旧播放器会话覆盖

**触发与结果。** 播放一部影片时选择 480P，退出后到设置保存默认 720P，再打开另一部影片。设置保存为 720P，但请求仍携带 480P，实际 MP4 为 640 像素宽。两轮都通过真实菜单执行，见两份 renderer JSON 的 `new-settings-defaults-overridden-by-previous-player-session`。

**原因。** [Player.tsx](../src/renderer/Player.tsx) 第 18 行的模块级 `sessionPreferences` 跨播放器挂载保留；第 20、83 行始终让其画质优先于新设置，第 228 行写入后没有随设置修改失效。设置页的正常保存入口在 [pages.tsx](../src/renderer/pages.tsx) 第 265 行。手动选择跨片记忆可以保留，但必须定义与显式修改默认值之间的优先级。

**建议与验收。** 保存新的全局默认值时，清除或版本化对应会话偏好；当前影片的临时选择与后续影片默认值应分别管理。用同一操作链验证新影片请求 720P，并确认已有影片的正常换画质及未改设置时的记忆规则仍符合约定。

### D07 · 媒体加载把倍速重置为 1×，界面仍显示旧值

**触发与结果。** 在全新会话中保存默认 1.5×后首次播放 MP4，界面为 `1.5×`，原生 `playbackRate=1`。手动选 2×能够实际生效；随后切换画质，实际速率再次为 1，标签仍为 `2.0×`。两轮均确认播放已经输出视频帧，见 [speed-load-probe.json](evidence/usage-audit-2026-11-22/speed-load-probe.json)。

**原因。** [Player.tsx](../src/renderer/Player.tsx) 第 335 行在设置新媒体 source 前赋值 `playbackRate`；第 475 行加载 MP4 时，原生速率重置为仍是 1 的 `defaultPlaybackRate`，第 364 行的 `loadedmetadata` 未重新应用速率。事件跟踪显示应用只赋值 1.5 或 2；随后 `loadstart / loadedmetadata / playing` 都记录实际速率 1，没有脚本赋值 1。因此界面状态与媒体状态已分离。

**复验纠正。** 早期组合偏好样本观察到“保存 1.5×后仍为 1×”，曾考虑会话覆盖或自适应降速。独立的新会话和 setter/event 跟踪推翻了该样本的这两种归因，本文撤回它们，把上述 MP4 结果归入媒体加载时的重置。HLS 路径尚未用同一事件探针独立复验，不能扩大为所有格式的实测结论。

**建议与验收。** 在媒体加载生命周期中同步默认速率、当前实际速率和界面标签，兼顾用户请求速率与已发生的自适应调整。默认非 1×、手动改速后换画质/换线/切集/重试均需比较原生速率和标签；MP4 与 HLS 分开执行，且保留既有丢帧自适应测试。

## 有依据的改进点

以下行为有可执行依据，但涉及既有的完整性、错误暴露或性能取舍，列为改进项，避免把有意设计都报成 bug。

### A01 · 可选演职员和照片请求不应挡住基础内容与播放

两端基础 subject 已返回时，仍等待 credits/photos 完成才返回 detail。桌面 [douban.ts](../src/main/data/douban.ts) 第 412–429 行使用 `Promise.allSettled`，TV [DoubanDataSource.kt](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt) 第 613–630 行等待两个任务。桌面播放 IPC（[ipc.ts](../src/main/ipc.ts) 第 89–100 行）也先等待 detail。

两轮把可选响应用 600 ms gate 暂时阻塞，基础数据已就绪但 detail 未返回；桌面播放 resolver 的调用次数仍为 0。释放 gate 后才继续。见两份 data JSON 和 JVM XML 的 optional 场景。**600 ms 是控制输入，不是本机线上接口延迟或对自然超时频率的测量。**

建议先交付经过验证的基础详情和播放所需字段，再独立补充可选素材，保留当前 principal credits 选择规则和诊断。验收以“可选接口持续阻塞时，基础详情与解析可继续”为准；缺失素材省略，不能伪造演员、照片或片长，也不能吞掉基础 subject 的失败。

### A02 · 大型收藏需要首屏、取消与局部失败机制

10000-ID 契约已经对齐，但 [desktop byIds](../src/main/data/douban.ts) 第 463–477 行与 [TV byIds](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt) 第 704–725 行仍逐条 await 缺失记录。80 条控制输入的桌面样本最大并发为 1，读取全部完成前不返回首屏。另一个样本中，两条缓存记录与一条未缓存的 503 混合读取，整批抛错，而两条缓存单独读取仍成功；两端各做了两轮。

桌面 [LibraryPage](../src/renderer/pages.tsx) 第 248、255 行在整批错误时只呈现错误页。桌面元数据缓存预算 2500、TV 持久化预算 1200，冷启动和大收藏更容易进入此路径。现有容量修复解决的是合法列表准入，没有解决逐条加载和失败隔离。

建议做有界分页/并发、离开即取消、显示已加载条目及逐项错误/重试。对 2501/10000 条列表验证首屏时间、请求数、顺序、取消与重启；对部分 503 保留缓存内容和准确错误。不能用“所有失败都返回空数组”来换取表面可用，也不要把缓存扩大到无界。

### A03 · 桌面损坏状态需要可到达的恢复入口

桌面保留损坏原件、明确失败有助于避免静默丢失，但目前用户无法在界面完成恢复。[state.ts](../src/main/state.ts) 第 60–65 行在构造时解析并校验状态；[App.tsx](../src/renderer/App.tsx) 第 200 行以该错误阻断全部页面。在两个隔离损坏 profile 上，用真实 main、preload 和当前 renderer 各重试 3 次，仍只显示“操作失败，请重试”；导航到设置和频道也没有设置主体或卡片，原损坏文件保持不变。证据见 [desktop-corrupt-state.json](evidence/usage-audit-2026-11-22/desktop-corrupt-state.json)。

建议提供保留原件的备份/导出、明确说明影响的重置流程，以及不依赖健康用户状态的恢复页；可评估只读浏览模式。验收须证明错误页上的操作能实际恢复或导出，普通“重试”不能被当作修复。相关文案应遵守 `src/copy.extra.ts` 和 safeError 的现有约束。

### A04 · 图片磁盘预算在单次长会话内缺少持续约束

[proxy.ts](../src/main/playback/proxy.ts) 第 105 行只在启动 20 秒后安排一次 prune；[image-cache.ts](../src/main/playback/image-cache.ts) 第 46–58 行后续写入不会触发清理。默认预算为 200 MiB。缩小预算到 40 KiB 的真实 ImageCache 样本，20 次写入后达到 320 KiB，显式 prune 后降至 32 KiB，两轮一致。它证明调度上的软预算，**不表示生产缓存已实际达到相同倍数或占用量**。

建议按累计写入量触发低频、去重的后台清理，并避免给首屏路径增加目录扫描。验收覆盖清理后继续浏览、重复触发合并、写入失败和关闭期间清理；在设定滞后范围内保持磁盘预算，同时保留启动性能门槛。

## 本次验证及边界

| 验证 | 本次运行 | 结果与解释 |
| --- | --- | --- |
| 桌面离线 | `npm test`，22:07:23 起，23.24 秒 | 23 文件、302/302；这些通过项未覆盖上述全部操作组合 |
| 类型和当前构建 | `npm run build`，22:15:29 起 | 含 typecheck，通过；保留了既有 bundle 大小提示 |
| TV 离线复验 | 第二轮 XML 时间 22:43:24；Gradle 强制重跑任务 | 61/61 = 56 项既有测试 + 5 项临时诊断测试；25 个 task 实际执行，零失败/错误/跳过 |
| 定向业务复现 | 两轮 data、TV JVM 与 renderer；另有两轮新会话倍速探针 | 诊断断言验证“故障存在”，不表示故障已修复；临时测试未加入生产或正式回归目录 |
| 真实网络桌面 | 23:00:41–23:02:39，串行 3 项 | 元数据/15 组频道筛选/联想/分页、电影解码与 seek/手动倍速/全屏/历史、连续切集，3/3 |
| 设计与发行工具 | 交付前再次运行 `verify:design`、原合同、`test:release` | 206 文件基线不变、405 checks、6/6；原设计文件未修改 |
| 已安装 TV APK | 22:49 两次只读目录下设置保存 | 两次主线程崩溃复现；用户状态和权限恢复，随后独立核对 |

真实网络结果见 [live-result.json](evidence/usage-audit-2026-11-22/live-result.json)和 [build-live 证据索引](evidence/usage-audit-2026-11-22/live/README.md)。它们使用**当前 `out/` 构建**，没有使用用户 Windows 安装或 packaged executable；本次没有进行完整 fixture suite、全源网络审计、NSIS 安装或新的 TV release lint/assembly。此前包内、启动重复采样和 TV 导航/播放的结果仍由此前审计拥有，本文不把它们并入本次通过数。

实际使用的诊断源快照和恢复到临时目录的运行说明见 [repro/README.md](evidence/usage-audit-2026-11-22/repro/README.md)。这些诊断断言证明当前故障存在；修复验收必须对照本文每项期望结果，不能把诊断脚本正常退出当成已修复。

TV 设备为 MuMu 实例 1、Android 15/API 35，安装候选 APK SHA-256 为 `340D954727612FD89DE97848D44522DB06C5457C907AB267385FFDBE8B1C296D`。这是此前已安装候选，不是用本次诊断测试构建的 APK。完整原用户状态、目录/文件权限、源覆盖、IPv4/IPv6 规则和显示设置均已恢复；[设备恢复摘要](evidence/usage-audit-2026-11-22/tv-storage-summary.json)、[独立状态复核](evidence/usage-audit-2026-11-22/tv-restoration-independent.json)和[最终实例状态](evidence/usage-audit-2026-11-22/mumu-final-independent.json)分别记录恢复完成和 Android/实例进程关闭。用户备份只保存在忽略的临时目录，没有提升到文档证据。

## 建议实施顺序

1. **先处理 TV 数据与取消边界（D01–D03）。** 防止应用退出和原状态被覆盖，让仍有效的播放请求能完成；保持旧状态和主动取消语义。
2. **修复播放状态一致性（D05–D07）。** 把线路偏好与预加载缓存联动，定义默认设置优先级，并让媒体原生速率与界面同步。
3. **恢复浏览连续性（D04），改进首屏与局部失败（A01–A02）。** 用有界数据快照和请求边界解决返回丢页、大收藏整批阻塞及可选请求拖慢基础内容。
4. **补齐恢复和长会话预算（A03–A04）。** 给损坏状态一个可到达的处理路径，并持续控制图片缓存。

修复时应重放本文的同一触发条件，保存故障前后结果，再跑离线套件；涉及播放与 TV 交互时追加最终 APK/真实媒体回放。源策略、双端共享规则或启动链路若随修复改变，还须执行仓库规定的对应 probes、黄金向量和 TV 构建检查。

还需要单独采样：两个实际可播源的换线接管、MP4/HLS 加载倍速、长时间播放、低内存和 API 22 真机。此前网络审计中的目录超时与 TV 起播不可用样本仍值得跟踪；本次 3 项网络通过不能确定所有源的可靠性，也不足以永久禁用任何来源。每个后续判断应保留目录、媒体探测和首帧阶段的原始证据。
