# Panda 使用问题修复与验证 · 2026-11-23

本页记录 11 月 23 日的工作区。文中的本地日志名和临时安装包名用于识别该次运行，仓库内可复核的汇总见[验证记录](evidence/usage-fixes-2026-11-23/validation.json)。

[使用审计](usage-audit-2026-11-22.md)中的 **7 项缺陷（D01–D07）和 4 项改进（A01–A04）已在当前工作区修复**。相同输入的回归由失败转为通过，桌面离线 317/317、完整 fixture 40/40、TV 离线 70/70 通过。最终 Windows 候选与已安装 TV APK 均完成运行验证。

**完整联网验收仍有失败。** Windows 构建为 12 通过、3 失败、2 跳过，最终 unpacked 包为 12 通过、4 失败、1 跳过；失败集中在限定单源起播与首字母检索。下文保留每次失败和分阶段复验，不能把本次交付概括成“全部联网测试通过”。

本轮改动保留在工作区，没有提交、发布或升级用户的 Windows 安装。原有未提交修改继续保留，HEAD 仍为 `4220d6dff973a55f42508a49a9c0c3d43d3b296a`。基线于 **2026-11-23 00:24:56（UTC+8）**保存；其中 196 个文件仍存在。代码、测试及证据摘要见 [validation.json](evidence/usage-fixes-2026-11-23/validation.json)和[最终源码摘要](evidence/usage-fixes-2026-11-23/final-source-identity.json)。以下时间均为 Asia/Shanghai，JSON/XML 保留原 ISO 时间。

## 逐项结果

| ID | 审计级别 / 场景 | 当前行为 | 修复前与修复后证据 |
| --- | --- | --- | --- |
| D01 | P1 · TV 保存设置或播放历史遇到写权限错误 | 应用级串行 IO 队列保存，成功后更新状态；失败显示保存提示并保持最后提交的状态。恢复权限后可重试，播放继续前进 | 原 APK 的 EACCES 崩溃[复现两次](evidence/usage-audit-2026-11-22/tv-storage-summary.json)；最终 APK 的[设置保存 2/2](evidence/usage-fixes-2026-11-23/device/storage-verified.json)、[播放中历史保存 2/2](evidence/usage-fixes-2026-11-23/device/history-verified.json)，播放时钟均由 2 秒继续到 5 秒 |
| D02 | P1 · TV 损坏状态被默认为空并覆盖 | 区分首次使用和损坏状态；损坏时阻止普通读写、进入恢复页。确认恢复/重置前逐字节归档原件和已有备份 | 冻结源码上的[新回归失败](evidence/usage-fixes-2026-11-23/before-tv-state-and-cancel.xml)，原审计另有两轮 JVM 复验；当前 UserStore 回归通过，最终 APK 的[恢复流程 2/2](evidence/usage-fixes-2026-11-23/device/recovery-verified.json)覆盖取消、Back、有效/无效备份、重置和重启 |
| D03 | P1 · 旧 TV 详情调用取消误伤有效跟随者 | 有效跟随者检查自己的协程后重新取得任务；自己的取消继续传播，普通错误仍可共享 | 冻结源码上的[取消回归失败](evidence/usage-fixes-2026-11-23/before-tv-state-and-cancel.xml)；当前[UsageStateTest](evidence/usage-fixes-2026-11-23/tv-unit-complete/TEST-app.panda.tv.UsageStateTest.xml)通过领导者取消、跟随者自身取消、普通错误共享三个独立时序 |
| D04 | P2 · 桌面第三页卡片进入详情后返回丢失 | 按路由/筛选共同保存分页内容、cursor、离开时滚动和实际链接焦点；预算淘汰时一起重建 | 原 renderer 的频道/影人三页返回均失败，两轮（`before-fixture-corrected.log`）；当前相同回放两轮通过，收藏第三页返回也通过，见28 项重复回放（`usage-complete.log`） |
| D05 | P2 · 手动换线未使下一集预加载失效 | 成功的最新手动选择推进作品偏好版本，清除旧预加载；晚到自动结果和已被替代的手动结果不能覆盖赢家。两端规则一致，映射有界 | 已完成预加载的原回归（`before-desktop-unit-second.log`）及晚到/重复选择两轮红灯（`before-source-races-red-1.log`）；当前桌面离线全套通过。TV 三个相同时序[两轮红灯](evidence/usage-fixes-2026-11-23/before-tv-preferences-first.xml)→[最终通过](evidence/usage-fixes-2026-11-23/tv-unit-complete/TEST-app.panda.tv.PlaybackPreferencesTest.xml)，并强制复跑 |
| D06 | P2 · 新保存的默认画质被旧会话偏好覆盖 | 成功保存对应默认值后清除旧临时偏好；相同值的显式保存也采用这个优先级 | 原 renderer 的“480P → 设置 720P → 新影片”两轮失败（`before-fixture-corrected.log`）；当前真实菜单与本地 MP4 回放两轮通过（`usage-complete.log`），新影片请求采用 720P |
| D07 | P2 · 倍速标签和实际媒体速率分离 | source 加载前、loadedmetadata、手动改速和自适应调整同时同步默认速率与实际速率 | 原 MP4 两轮失败，HLS 扩展红灯（`before-fixture-extended-red.log`）；当前MP4/HLS 原生解码回放（`usage-complete.log`）覆盖非 1×首次加载、换画质和 HLS 切集，两轮通过；既有丢帧自适应与换线回归也通过 |
| A01 | 可选演职员、照片阻塞基础内容和播放 | 首屏及播放使用经过校验的基础 subject，完整 detail 独立补充；主要演职员契约保留。TV 补充内容维护既有控件，并等待焦点离开演职员 holder 后再替换 | 桌面原回归红灯（`before-desktop-unit-second.log`）→当前 unit/renderer 同输入通过。TV 同一 optional gate [第一轮](evidence/usage-fixes-2026-11-23/tv-primary-before-1.xml)、[第二轮](evidence/usage-fixes-2026-11-23/tv-primary-before-2.xml)失败→[第一轮](evidence/usage-fixes-2026-11-23/tv-primary-after-1.xml)、[第二轮](evidence/usage-fixes-2026-11-23/tv-primary-after-2.xml)通过；full detail 仍在等待 gate |
| A02 | 大型收藏首屏迟滞、整批失败、离开后继续请求 | 双端每页最多 30 个 ID、最多 3 个缺失元数据读者，先显示缓存；桌面按 6 项补充。返回有序成功、局部失败和待加载项；离开取消，失败项单独重试 | 原串行/整批失败（`before-desktop-unit-second.log`）和2501/10000 首屏、部分错误、取消回放（`before-fixture-extended-red.log`）失败→当前相同回放通过；TV JVM 验证大列表、局部 503 和取消，最终 APK 回放“我的”与返回状态 |
| A03 | 桌面损坏状态只能反复重试 | 独立恢复页提供导出、恢复备份与确认后重置；渲染器不提供文件目的路径。有效原件和备份保留 | 原 main/preload/renderer 4 次失败（`before-recovery.log`）→当前定向重复回放 4/4（`after-recovery-verified.log`），最终 unpacked 包两项恢复回放也通过；核对实际导出字节、取消、归档和重启 |
| A04 | 图片磁盘预算只在启动清理时约束 | 累积写入达阈值后合并安排延迟清理；清理期间的新写入继续触发后续批次；关闭等待写入并最终清理 | 相同 40 KiB 预算 / 20 次写入的原回归超额（`before-desktop-unit-second.log`）→当前自动清理回归通过；并发写入、关闭和重启通过，最终包 20 次首次启动性能回放通过 |

TV 的 A01 兼容测试在冻结原源码缺少 `subject` 成员时，以测试扩展映射到当时 MainActivity 使用的 `detail`；最终成员函数优先。两轮使用同一 JUnit 文件和 HTTP gate，原 DoubanDataSource 没有改写，摘要见[映射与校验](evidence/usage-fixes-2026-11-23/tv-primary-admission-adapter.json)。D05 的原 TV 时序测试只加媒体读取适配，未改变缓存、偏好或赢家逻辑，见[IO 适配摘要](evidence/usage-fixes-2026-11-23/tv-before-probe-adapter.json)。这些是确定性业务证据。

桌面 fixture 使用编译后的生产 renderer 与隔离数据；MP4/HLS 倍速检查读取原生媒体属性并要求实际输出视频帧。这些固定影片和加载计时用于复现行为，不用于评价线上目录、实际片源画质或网络可用率。A03 仅把原生保存对话框的目的路径选择换成测试替身，IPC、编码、文件写入与恢复执行真实代码。

## 实现边界与追加回归

实现入口包括[桌面状态](../src/main/state.ts)、[TV 保存队列](../tv/app/src/main/java/app/panda/tv/state/UserStateWriter.kt)、[基础数据与片单](../src/main/data/douban.ts)、[IPC 取消归属](../src/main/ipc.ts)、[片单 hook](../src/renderer/library.ts)、[返回快照](../src/renderer/page-memory.ts)、[播放偏好](../src/renderer/playback-preferences.ts)、[播放器](../src/renderer/Player.tsx)和[图片缓存](../src/main/playback/image-cache.ts)。

返回快照最多 12 个上下文、2400 张卡片、每个上下文 600 张；超过预算后返回从首屏重建。终止空页不保留，避免筛选重试恢复旧空结果。IPC 对取消令牌校验、按窗口拥有请求，最多 8 个活动令牌；窗口关闭时取消剩余工作。HTTP 共享任务只有全部读者离开才结束传输，排队、节流、重试等待均可取消。

图片预算是有清理滞后的软预算：累计写入 `min(预算 × 20%, 8 MiB)` 后延迟 1 秒清理，合并重复调度，保留启动路径的延迟扫描。异常磁盘条件与高速写入期间仍可能短暂超过预算。

全套回放另暴露了两个返回/重试边界，均完成两次故障复现与当前验证：

- 筛选空页被旧返回快照复用：两次红灯（`empty-memory-red.log`）→相同全场景两次通过（`empty-memory-verified.log`）。
- 收藏和历史单项重试后的焦点恢复：先纠正无效的 `a.card` 测试选择器，再复现收藏真实焦点失败（`library-focus-corrected-red.log`）与历史播放链接焦点失败（`history-focus-red.log`）。当前定位卡片内的实际 `.card__link`，两入口都在最终 fixture 中通过。

早期 `.cmd` 正则转义、缺少目录连接、错误卡片选择器、协程线程名后缀以及存储 helper 漏掉“自动”字样等无效探针保留在 `.tmp/`，不计作产品缺陷或修复证据。HLS `.ts` 媒体被 TypeScript 当源码的构建问题已通过排除 `e2e/fixtures` 解决。全部测试素材继续留在测试目录。

技术取舍与备选方案见状态/加载/返回记忆决策（`2026-11-23-usage-recovery.md`）、[播放稳定性](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-19-playback-stability.md)与[启动缓存](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-17-startup.md)。

## 最终校验

| 层级 | 时间与结果 | 证据 |
| --- | --- | --- |
| 桌面类型与构建 | 03:02:49–03:02:57，含 typecheck，通过；renderer `index-CNamo9sS.js`，保留既有大 bundle 提示 | 构建（`build-complete.log`） |
| 桌面离线 | 03:02:50 起，22.54 秒，26 文件、317/317 | offline（`offline-complete.log`） |
| 使用问题重复回放 | 03:02:57–03:04:41，14 场景各两轮，28/28 | usage（`usage-complete.log`） |
| 完整 fixture | 03:04:41–03:11:27，40/40 | fixture（`fixture-complete.log`） |
| TV 离线与最终包 | 03:48:46–03:49:01，全套 70/70、lintRelease、assembleRelease 通过；最后补充的 A01 两轮转绿。新增内容只在测试目录，APK 字节保持一致 | Gradle（`tv-checks-complete.log`）、[JUnit 摘要](evidence/usage-fixes-2026-11-23/validation.json) |
| 黄金向量与兼容边界 | 重导黄金向量，parity 测试通过；minSdk 22、Media3 1.8.1；无 NewApi fatal。APK v1/v2 签名通过 | 签名（`tv-final-signature.log`）、[golden vectors](../tv/app/src/test/resources/golden-vectors.json) |
| 设计与原契约 | 03:21:54，206 文件 SHA256 不变，405 原契约断言通过；发行工具测试 6/6 | design（`design-complete.log`）、contract（`contract-complete.log`）、release tools（`release-tools-final.log`） |
| Windows 包内容 | app.asar 271 项；测试、e2e、脚本、source map、node_modules、design mock/art/preview 均为 0 | asar check（`asar-check-complete.log`） |

全部 Electron 回放串行执行，使用新的隔离 profile。修复前的已编译 renderer、业务源文件和 APK 保留在 `.tmp/usage-fixes-2026-11-23/`；最终构建证据与旧包、固定数据证据分开。

## 实际运行与网络结果

Windows 的完整构建/包回放分别于 **03:14:49–03:20:29**、**03:20:29–03:27:16**执行：

| 回放 | 通过 / 失败 / 跳过 | 观察 |
| --- | --- | --- |
| 当前 `out/` 与真实 main/preload/network | 12 / 3 / 2 | 元数据、15 组频道筛选、人物作品、电影/剧集/动画解码与拖动、历史、恢复、启动通过。暴风、量子单源起播超时；首字母检索失败。两项仅供 packaged 的测试跳过 |
| 最终 Windows unpacked | 12 / 4 / 1 | 上述主要路径、原生窗口尺寸/控件命中、六次播放器进入/离开资源释放通过。暴风、电影天堂、量子单源起播超时；首字母检索缺少预期作品。开发构建的启动 hook 跳过 |

原断言与失败均保留：[构建完整结果](evidence/usage-fixes-2026-11-23/checks/build-live-complete.json)、[最终包完整结果](evidence/usage-fixes-2026-11-23/checks/packaged-live-complete.json)。最终包的[UI/资源摘要](evidence/usage-fixes-2026-11-23/ui-performance-lifecycle-summary.json)是有限的六次导航采样：离开的播放器和 video 弱引用均释放；它不能证明数小时或所有硬件上的性能。

源与起播 probes 各做两轮，使用本机 **system route**，准入改为与应用相同的 `subject`，仍带原始别名和集数提示：

| probe | 第一轮 | 第二轮 |
| --- | --- | --- |
| 五频道热门首集（各 4 部） | 15/20 读到媒体首字节 | 14/20 |
| 六组长篇分年条目 | 43/48 | 42/48 |
| 其中带集数区间的条目 | 30/31 | 29/31 |
| 起播与中段读取，16 部 | 12/16；成功样本 probe total 中位 1,612 ms、最慢 6,254 ms | 13/16；中位 1,446 ms、最慢 4,698 ms |

记录见[源第一轮](evidence/usage-fixes-2026-11-23/network/sources-first.json)、[源第二轮](evidence/usage-fixes-2026-11-23/network/sources-second.json)、起播第一轮（`start-first.log`）、起播第二轮（`start-second.log`）。`probe total` 是目录搜索、解析、清单与首片读取之和，基础 subject 和中段读取分别记录。首字节可读不等于完整解码；自然超时、目录未完整收录和未来条目均保留原结果。没有据此全局停用片源，也没有把本机结果扩大为国内网络可靠性结论。

对额外联网失败又做了独立复验：

- 相同四个首字母查询的原测试在冻结修复前构建 **2/2 失败**，最终包 **2/2 仍失败**。同一查询集的首个失败查询随请求结果变化；主接口出现 UPSTREAM，补充接口空答复或只返回部分身份。检索算法段本轮文本 SHA256 完全相同，见[对照](evidence/usage-fixes-2026-11-23/initials-comparison-summary.json)。检索可靠性仍是未解决问题。
- 在后续新查询诊断中，三个影片各两轮都先遭遇元数据 HTTP 400，尚未进入片源阶段，见[元数据阶段诊断](evidence/usage-fixes-2026-11-23/single-sources-diagnostic.json)。
- 再采用此前失败 E2E 已实际校验并保存的影片记录，单独隔离目录/媒体阶段：暴风、量子两轮均在目录请求的约 9 秒截止及重查后失败；电影天堂两轮读到首片。见[目录阶段诊断](evidence/usage-fixes-2026-11-23/single-sources-catalogue-diagnostic.json)。该诊断省略元数据准入，仅说明当次目录/首片状态；电影天堂的先前 packaged 解码超时仍计为失败。

## 启动与 TV 已安装回放

最终 Windows 候选于 **03:27:16–03:27:58**执行 **20 次全新 profile 首次启动 + 3 次再次启动**，全部首页内容、全页栏目与 18 张可见图片完成加载。计时从进程创建开始，p95 使用 nearest rank：

| 首次启动阶段 | 中位 / p95 / 最慢（ms） |
| --- | --- |
| 骨架 | 438 / 513 / 549 |
| 首页顶部数据 | 713 / 856 / 858 |
| 可见图片完成 | 1174.5 / 1424 / 2445 |
| 全页栏目完成 | 1698.5 / 1998 / 2088 |

再次启动的全页中位 600 ms、可见图片中位 690 ms。记录见[启动摘要](evidence/usage-fixes-2026-11-23/startup-summary.json)与[23 个原始样本](evidence/usage-fixes-2026-11-23/startup-complete/startup-timing.json)。这是当前系统路由下的进程/profile 首次启动，不覆盖冷 DNS、所有线路或长期运行。

TV 使用 MuMu 实例 1、Android 15 / API 35、实际查询得到的 serial `127.0.0.1:16416`。同一最终 APK 的批次如下：

| 回放 | 结果 | 证据 |
| --- | --- | --- |
| 原生 1920×1080、720p/160dpi、4K/480dpi 界面 | 各 8/8；每批含一个明确标注的辅助顶栏点击案例 | [原生](evidence/usage-fixes-2026-11-23/device/surfaces-native.json)、[720p](evidence/usage-fixes-2026-11-23/device/surfaces-720p-complete.json)、[4K](evidence/usage-fixes-2026-11-23/device/surfaces-4k-complete.json) |
| 扩展导航与片单 | 23/23 | [navigation](evidence/usage-fixes-2026-11-23/device/navigation.json) |
| 首页“更多”与导航选择 | 6/6，三处各两轮 | [nav-selection](evidence/usage-fixes-2026-11-23/device/nav-selection.json) |
| 搜索状态 / 阻断分页恢复 | 3/3 与 3/3 | [search](evidence/usage-fixes-2026-11-23/device/search.json)、[pagination](evidence/usage-fixes-2026-11-23/device/pagination.json) |
| D-pad 节奏与持续按键 | 4/4；p95 5 ms，最差批次 1/270 janky frame | [motion](evidence/usage-fixes-2026-11-23/device/motion.json) |
| 设置写失败 / 损坏状态恢复 / 播放中历史写失败 | 各 2/2，见逐项矩阵 | [storage](evidence/usage-fixes-2026-11-23/device/storage-verified.json)、[recovery](evidence/usage-fixes-2026-11-23/device/recovery-verified.json)、[history](evidence/usage-fixes-2026-11-23/device/history-verified.json) |
| 播放全场景 | 13 通过、0 失败、2 unavailable；《三体》两轮没有可选的备用线路 | [playback-all](evidence/usage-fixes-2026-11-23/device/playback-all.json) |
| 改用真实电影《流浪地球2》换线 | 2/2，金鹰 → 360，切换后播放前进 | [line-switch](evidence/usage-fixes-2026-11-23/device/line-switch-movie.json) |

播放全场景中 `missing-source` 的实际 verdict 为 **retryable**，它证明可重试错误界面可用，没有证明目录确认无收录。两个《三体》换线 unavailable 样本保持原标记，后来的电影换线成功单独记录。

设备在安装/注入前保存完整状态。最后于 **03:18:42**用独立 verify 核对所有 `user-state.json*`、源覆盖文件、mode/UID/GID/SELinux context、IPv4/IPv6 OUTPUT 规则、显示/旋转/字号设置；MuMu 配置与原值完全一致，最终恢复原先关闭状态，保留已验证的最终 APK。见[恢复摘要](evidence/usage-fixes-2026-11-23/device-restoration-summary.json)。原用户字节和设备快照只在忽略目录 `.tmp/` 保存。

## 候选身份与剩余改进方向

| 候选 | 身份 |
| --- | --- |
| Windows unpacked（`Panda.exe`） | 1.1.4；app.asar 13,812,954 字节，SHA256 `3B5E3482747CDEDEDD63BBAA3AF65C0E8380EC5212897478717FC8304645D643`；[完整身份](evidence/usage-fixes-2026-11-23/windows-final-identity.json) |
| TV APK（`Panda-TV-1.0.14-usage.apk`） | 1.0.14 / versionCode 15 / minSdk 22；1,842,556 字节，SHA256 `59EA7C0082A09BA8568E8325BFAB2BF0C3FF427AA751E36B373A0557DEEA1401`；v1/v2，证书 SHA256 `d49e8eaee47712b2dac54444ef627d53fd2bf302ddc67ecdcbd3d8d695073fcd` |

版本号沿用原候选，以上字节摘要区分本轮工作区与已发布包。Windows 验证对象是该独立 unpacked 可执行文件，NSIS 升级/卸载和用户安装目录没有在本轮验收。

后续优先处理与验证：

1. **检索与片源的真实可靠性。** 按国内网络、具体片名和阶段继续测量，完善可观测性和部分结果提示。本轮主接口错误、限定单源超时及电影天堂 packaged 解码失败仍未消除，不能用扩大空态或伪造片名兜底。
2. **目标电视上的兼容与性能。** API 22 静态检查通过，运行证据来自 API 35 模拟器；仍需目标 TV 的 TLS、解码、遥控和进程后台恢复样本，以及数小时播放、低内存/低磁盘边界。
3. **冷缓存的大型片单与长会话。** 本轮证明 2501/10000-ID 首屏按页读取、取消和局部失败，未证明 10000 张卡片全部连续滚动或真实网络下的全量吞吐；按实测评估虚拟化与更长期的资源曲线。
4. **正式安装交付。** 若进入发行阶段，使用新候选生成 NSIS 并独立验证安装/升级/卸载与签名；现有发布物继续按其原交付报告识别。
