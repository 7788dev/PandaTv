# Panda 系统审查与可验证修复

下文的测试名按审计当天记录。现存的两端结果见[验证汇总](evidence/system-audit-2026-11-22/validation.json)。

本轮确认并修复四项产品缺陷：桌面播放位置冻结时恢复被下载事件掩盖、双端简略卡片覆盖已确认分类、合法的 2501 条收藏读取被拒绝，以及限流器交接时突破并发容量。修复前后使用同一组触发条件复验，最终源码的离线测试和构建检查通过。真实网络验收有通过项，也保留了目录超时、TV 起播失败和换线样本不足，不能据此声称所有源、设备和播放场景都已通过。

审查日期为 **2026-11-22，以下时间均为 Asia/Shanghai（UTC+8）**。工作区起点为 `4220d6dff973a55f42508a49a9c0c3d43d3b296a`，开始时已跟踪文件无修改；原有未跟踪证据保留。本轮未提交、推送或发布，也未升级用户的 Windows 安装。候选沿用桌面 1.1.4 / TV 1.0.14 版本号，须用下文包摘要识别。

审阅摘要、每批命令、运行时间、包身份和原始报告路径集中在 [validation.json](evidence/system-audit-2026-11-22/validation.json)，交付前的改动范围、文档链接与身份核对见 [final-review.json](evidence/system-audit-2026-11-22/final-review.json)。临时日志、故障截图及完整测试输出保留在 `../.tmp/system-audit/`；提升到 `docs/evidence/` 的文件不包含原用户配置或完整用户状态。

## 场景与架构复核

桌面链路为 React renderer → 类型化 preload → Electron main → 元数据适配、持久化、片源解析与本地媒体代理。TV 在原生 Kotlin 客户端实现对应规则，使用相同源配置和导出的黄金向量。审查沿用户操作跨层追踪状态和请求，再用确定性输入、隐藏生产 renderer、真实网络及已安装 APK 分别验证。

| 实际场景 | 审查范围与本轮结果 | 证据边界 |
| --- | --- | --- |
| 进入首页、切频道、筛选和翻页 | 元数据归一化、主题分类、端点缓存、分页与海报；修复简略卡片的分类覆盖；桌面真实网络覆盖 15 组频道筛选、组合筛选、分页和海报 | 合成输入验证缺字段合并；线上样本验证实际接口，未穷尽全部影片与筛选组合 |
| 搜索、联想、首字母与影人作品 | 请求取消、旧结果隔离、键盘/遥控器流程；桌面真实网络和 TV 搜索回放通过 | TV 搜索回放为 3 个样本，未覆盖所有失败时序 |
| 收藏、历史、返回原位置和重启 | 用户状态上限、元数据读取上限、持久化、卡片分类与焦点/滚动基线；修复 2501 条合法列表被拒绝 | 大型列表测试使用替代请求及缓存输入，未声称 2501 部影片全部在线加载完成 |
| 连续播放、暂停、seek、倍速和切集 | 播放意图、原生时间轴、恢复次数、生命周期；修复下载/缓冲事件掩盖停滞 | 冻结复现属于故障注入；线上短时播放与真实解码另行记录 |
| 多源请求同时完成或排队 | 并发槽位、微任务交接、目录检索和媒体探测；修复 WorkLimiter 槽位被重复占用 | 单测证明并发边界；本轮未改变来源排序、作品匹配或全局删源 |
| TV 遥控器使用 | 真实焦点、首行返回、末行保列、详情返回、页面淘汰、选集面板、媒体键、入场取消 | MuMu Android 15/API 35，1920×1080；辅助点击与 D-pad 证据单独标记 |
| 长期维护与交付 | IPC/代理边界的既有回归、离线 suite、发行包内容、设计基线、双端规则与 API 下限 | 未发现需要本轮扩大修改的边界问题；不构成独立安全认证或 Windows 安装验收 |

## 四项修复及红绿证据

**1. 桌面播放已停止前进，下载仍进行时不会恢复。**

原 `Player.tsx` 的媒体 `progress`、`timeupdate` 和 HLS `FRAG_LOADED` / `FRAG_BUFFERED` 事件都会刷新停滞看门狗时间。下载或缓冲事件继续到达时，即使原生 `currentTime` 停在同一位置，20 秒停滞窗口也可能一直无法到期，用户会留在冻结画面。

现在这些事件只更新必要界面状态；看门狗按实际播放位置前进更新时间。暂停、缓冲和 seek 重置连续健康计时，避免把这些间隔计入 60 秒稳定播放窗口。正常的播放/seek 生命周期仍会重置看门狗基线。

新增 [renderer 回归](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/e2e/interaction.spec.ts) 先确认视频已输出帧，再把原生 `playbackRate` 设为 0 冻结实际位置，保持用户播放意图，持续派发 `progress` / `timeupdate` 并加速测试时钟。同一隐藏测试器加载原发布 ASAR renderer，**18:04:34–18:05:13 三次均未触发恢复**；修复后编译 renderer 在 **18:05:13–18:05:37 三次均触发 `data.retryPlayback` 并恢复解码**。

这是对特定停滞机制的可重复故障注入，不能当作第三方流自然发生解码冻结的线上证据。生产改动在 [Player.tsx](../src/renderer/Player.tsx)，取舍归入 [playback-stability](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-19-playback-stability.md)。

**2. 简略卡片把动画、纪录片或综艺降回普通 movie/tv。**

详情或搜索响应可通过 `genres` / `is_show` 确认主题类别；随后同一条目的列表卡片可能只携带格式和较短类型列表。双端缓存原来直接覆盖 `item.type`，收藏和历史中的类别会变化，并写入重启后的缓存。简介、别名和集数原来已有保留逻辑，本轮修复的是分类。

双端现在在格式相同、传入类型仅为 `movie` / `tv` 时保留既有主题类别。新明确主题证据或格式变化仍采用新记录。通过归一化后的合成输入复验动画、纪录片和 `is_show` 综艺，并检查保存与重新加载；新的动画证据仍可提升原普通格式。

桌面原代码在三类保留断言上失败，修后通过；TV 原代码在对应聚合测试上失败，修后通过。代码位于 [desktop MetadataStore](../src/main/data/store.ts) 和 [TV MetadataStore](../tv/app/src/main/java/app/panda/tv/data/MetadataStore.kt)，测试为 desktop（`metadata-store.test.ts`） / [TV](../tv/app/src/test/java/app/panda/tv/MetadataStoreTest.kt)。这一选择把主题字段缺失视为证据不足；若上游仅用省略字段表示更正，缓存主题类别不会降级。决策见 metadata-card-merge（`2026-11-22-metadata-card-merge.md`）。

**3. 用户状态接受的 2501 条收藏无法交给元数据层读取。**

UserStore 与桌面 IPC 接受最多 10000 个 ID，但双端 `byIds` 限制为 2500。合法收藏刚超过缓存预算，就在取列表时整批报错。现把读取上限对齐到 10000，缓存预算仍独立限制内存和磁盘。

桌面回归（`library-metadata.test.ts`） 用真实用户状态 reducer 生成 2501 个合法收藏，替代详情请求，验证返回顺序和每个缺失 ID 的读取；10001 个 ID 仍在任何请求前拒绝。[TV 回归](../tv/app/src/test/java/app/panda/tv/MetadataStoreTest.kt) 预置 2500 条缓存，再读取一个缺失 ID，避免发出数千真实请求。两端原代码均复现拒绝，修后通过。实现为 [desktop byIds](../src/main/data/douban.ts) / [TV byIds](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt)。

这次解决容量契约矛盾；**大型收藏分页和冷缓存加载性能尚未解决**。桌面缓存仍为 2500 条，TV 写入后仍保留 1200 条，缺失元数据继续逐条读取。

**4. WorkLimiter 释放槽位时，新请求与已排队请求可同时占用。**

原实现先 `active--`，再唤醒一个等待者；被唤醒者尚未恢复执行时，新微任务会看到空槽位并进入，随后等待者也进入。大量并行请求下，实际并发可超过配置容量，并进一步加重网络超时。

[限流器](../src/main/playback/network.ts) 现在直接把占用槽位转交队首等待者，仅在无人等待时减计数。[交接回归](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/tests/network-regression.test.ts) 固定微任务顺序：容量 1，旧代码实测最大并发 **2**，修后为 **1**，执行顺序保持等待者在新请求前。既有排队、Range 和 HLS 回归也继续通过，决策补入 [startup](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/architecture/2026-11-17-startup.md)。

四项中的数据/请求定向测试于 **17:56** 在原代码上得出 **11 项中 5 失败、6 通过**；于 **18:01** 在修后代码上 **11/11 通过**。TV 原代码加同一回归组为 **56 项中 2 失败**，修后最终 suite **56/56**。原生产源码副本和失败日志留在 `../.tmp/system-audit/before-source/`、`before-unit-reproductions.log`、`tv-before-unit.log`、`tv-before-results/`，未用修后结果覆盖。

## 最终验证与候选身份

| 层级 | 最终代码运行时间 | 命令或操作 | 结果 |
| --- | --- | --- | --- |
| 桌面类型/构建 | 18:01 构建；18:12 再查类型 | `npm run build` / `npm run typecheck` | 通过 |
| 桌面离线单测 | 18:02:30–18:02:55 | `npm test` | 23 文件，302/302 |
| 发布工具单测 | 18:02:55–18:02:56 | `npm run test:release` | 6/6 |
| 隐藏生产 renderer + 测试数据 | 18:09:27–18:15:26 | `npm run test:e2e:fixture` | 26/26，约 6.0 分钟 |
| TV 双端规则及构建 | 18:02:31–18:03:52 | 先 `node scripts/export-tv-vectors.mjs`，再 `tv/gradlew.bat testDebugUnitTest lintRelease assembleRelease --offline --console=plain` | 向量无实质差异；56/56、lintRelease、assembleRelease 通过，minSdk 22 |
| Windows unpacked 候选 + 真实网络 | 18:18:06–18:25:49 | 设置 `PANDA_E2E_EXECUTABLE` 后 `npm run test:e2e` | **11 通过、3 失败、1 跳过**，约 7.7 分钟 |
| 构建目录 + 真实网络 | 18:27:12–18:27:15 | 清除候选 executable 选择后，单独运行 startup reload 用例 | 1/1；不并入包内通过数 |
| 真实启动重复采样 | 18:27 汇总 | 候选 executable 上 `npm run probe:startup` | 20 次全新 + 3 次再次启动，全部加载成功 |
| 设计完整性/契约 | 18:16 | `npm run verify:design` / `node design/tools/test-contract.mjs` | 206 文件 SHA256 不变 / 405 项通过 |
| 最后助手分类与状态恢复 | 19:15–19:19 | `py_compile`、捕获证据的只读分类复验、独立状态核对和摘要晋升 | 四个前置失败保留；注入后期限严格；状态核对通过 |

Windows 使用 electron-builder 生成单独的 unpacked 候选，位于 `../.tmp/system-audit/windows-final/win-unpacked/Panda.exe`。`resources/app.asar` 为 **13,791,380 字节**，SHA-256 **`1841E6C18E200F2437EC4AC33A081E61CA5598B9D996E93CD4BBEB2DE96A7403`**。EXE 的 SHA-256 为 `0B64A1022B629CBCA5DB9FA53E2B94A10E7BA5A4E0EA988C26251EB7D4069241`。ASAR 检查共 271 项，测试、e2e、脚本、设计 mock/art/preview、node_modules 和 source map 均为 0。**本轮未生成或安装 NSIS 包，unpacked 回放不等同安装通过。**

TV 候选为 `../.tmp/system-audit/Panda-TV-final.apk`，**1,821,937 字节**，SHA-256 **`340D954727612FD89DE97848D44522DB06C5457C907AB267385FFDBE8B1C296D`**。versionCode 15 / versionName 1.0.14 / minSdk 22，v1/v2 签名通过，证书 SHA-256 为 `d49e8eaee47712b2dac54444ef627d53fd2bf302ddc67ecdcbd3d8d695073fcd`。**18:10:59** 安装到 MuMu 后读取设备 APK 摘要，与候选相同；下文设备回放均使用此 APK。

最终摘要晋升前再次核对六处生产源文件与构建时身份一致。原 `release/win-unpacked/resources/app.asar` 仍为 `9FBE21EA11AF38239AD63D7BFADBFB136BC06BBF98CE5FB55C8B5DA771133D26`；原 `release/Panda-TV-1.0.14.apk` 仍为 `25E9963471F04405A8DA8CE76FF80345ECD069CD4360D3BEB1D663B0D3001DD6`。交付报告里原 TV 摘要少一位的笔误已按实际文件校正。用户 `D:/Programs/Panda` 的 ASAR 只读核对为 `823108D66FCFD4C8E690BB24977401576A992CE91E3794433081B819DFE31302`，未启动、升级或卸载该安装。

## 桌面真实网络结果

包内 11 个通过项覆盖：豆瓣首页与真实海报、频道细分类与分页、联想和影人、首字母查询、电影控件与收藏历史持久化、连续三集与动画解码、原生窗口、交互性能与播放器释放、重启与窗口状态保存，以及 360 源的去广告跨切点/远 seek/回到开头后的实际解码。

《流浪地球2》在 **18:22** 确认真实视频帧，暂停后恢复、seek 到 500 秒、2×、全屏和 PiP 通过。seek 恢复 **1868 ms**；12.002 秒采样窗口前进 23.874 秒，实测速率 **1.989×**，输出 574 帧、丢 1 帧。《三体》第 1→2→3 集均输出 1920×1080 帧；《凡人修仙传 年番4》（`db-37457082`）也确认真实解码。这些是短时功能样本，未验证整部或长时持续播放。

六轮播放器挂载/退出后，旧 root/video 的 WeakRef 均已回收，活动 timer 为空，应用 root listener 数量与进入前基线一致；该样本没有显示持续累积，不证明所有长时内存路径均无泄漏。

三个失败对应强制单源 **bfzy / dyttzy / lzi** 的广告用例，均在 `e2e/ads.spec.ts:41` 首次等待解码时退出，尚未进入广告切点断言。随后 **18:28** 候选与 **18:29** 原发布 unpacked 包分别进行独立阶段探针：bfzy 的《漫长的季节》、dyttzy 的《三体》、lzi 的《庆余年 第二季》在两个包上都于目录检索失败，耗时约 **19.2–19.5 秒**，未取得媒体 URL；日志各有两次 9000 ms search abort。该对照没有支持“本轮修改引入新的广告过滤回归”，也不能证明这三个源在其他网络上无效。原失败批次和两个包的诊断都保留，未全局删源或将批次改成全绿。

包内跳过的 reload 用例依赖开发构建专用 hook，已在 `out/` 上单独通过一次。全新启动 20 次的中位时间分别为骨架 **465.5 ms**、页首 **782.5 ms**、可见海报 **1107 ms**、整页 **1867.5 ms**；整页最慢 **2279 ms**。再次启动 3 次整页中位 **596 ms**、海报 **802 ms**。定义与原始时间见 [startup-summary](evidence/system-audit-2026-11-22/startup-summary.json) / [startup-timing](evidence/system-audit-2026-11-22/startup-timing.json)，仅描述本机此窗口网络。

## TV 已安装 APK 回放及测试器纠正

设备为 MuMu 实例 1，序列号 `127.0.0.1:16416`，Android 15 / API 35。所有设备回放串行，临时源配置和网络规则在每批后恢复；开始和结束还做独立核对。

| 批次目录（均在 `../.tmp/system-audit/`） | 开始时间 | 原始结果 | 判断 |
| --- | --- | --- | --- |
| `tv-surfaces/` | 18:11 | 8/8 | 安全边距、页面与 Library 记忆、详情返回、确认和键盘返回通过；其中一项辅助点击单独标记 |
| `tv-navigation/` | 18:13 | 23/23 | 五频道、搜索、影人、收藏历史的回顶、保列和返回通过 |
| `tv-search/` | 18:18 | 3/3 | 查询、取消和旧结果隔离回放通过 |
| `tv-motion/` | 18:31 | 4/4 | 两轮普通/1250 ms 持续输入，885 个 UI 帧，jank 0，p95 5 ms；不是视频合成或低端 TV 性能证据 |
| `tv-playback/`（中断） | 早期批次 | 4 项在 Play 激活前等待超时 | 测试器要求已被滚出 accessibility tree 的详情标题持续可见；未实际执行对应播放，独立恢复记录保留 |
| `tv-playback-final/` | 18:37 | **12 完成、3 原始失败** | 两次真实断网恢复、seek/倍速/切集等完成；3 失败分别是暂停时钟取样和两个闲置 overlay 前置问题 |
| `tv-media-final/` | 18:46 | 1/1 | 按暂停时保存的实际位置对齐 UI 后，媒体键暂停稳定性通过 |
| `tv-lines-final/` | 18:47 | **0 完成、0 失败、2 不可用** | 普通 D-pad 呼出实际控件后，没有第二条真实可选线路 |
| `tv-playback-verified/` | 18:49 | **10 完成、2 原始失败、3 不可用** | 媒体键、焦点、seek/倍速/切集等完成；两个恢复样本在初次起播失败，两个换线无第二源，第二次详情返回起播失败 |
| `tv-errors-final/` | 19:03 | **0 完成、1 原始失败、1 不可用** | 两项都未取得前置播放进展，没有注入断网；一项超时 Retry，一项 80 秒仍停在 00:01 并显示“正在准备播放” |

[回放助手](../scripts/verify-tv-playback-transitions.py) 纠正三处测试器前置条件：在真实聚焦搜索结果上验证确切标题/评分，再进入详情并验证实际 Play/Resume 焦点；暂停断言以保存的原生位置对齐一秒 UI tick；等待线路按钮时用普通 D-pad 保持控件可见。它记录所选条目与真实控件焦点，未以辅助点击代替线路 D-pad 可达性。

**18:37 的同 APK 批次确实完成两次注入断网后的恢复**：约 40.173 / 40.195 秒出现错误，恢复网络后 Retry 到推进播放为 **6526 / 11602 ms**。最新完整和独立恢复复验则有四个前置播放问题，source 日志记录多次 360 媒体 probe timeout；这些起播问题保留，不用前批成功抵消。

**19:15 的只读分类复验**将最新四个 `playback-error:initial-playback` 观察识别为“断网恢复样本不可用”，保留原错误、截图、日志和原始批次数；它不是一次新设备播放，也不增加通过数。分类函数还用前批捕获的真实故障界面检查：已注入故障后的 `blocked-next-episode` / `retry` 期限仍严格归失败，不能进入不可用分支。证据见 [tv-classification-review.json](evidence/system-audit-2026-11-22/tv-classification-review.json)。

“没有片源”样本为《骑有此理 第四季》，实际 verdict 为 **retryable**。它只证明网络失败保留详情和重试路径，没有证明全目录确认无片。换线回放也尚未取得第二条真实可选源，不能报告换线通过。最新初次起播问题的外部网络与播放器行为还需有可控样本区分；不能把它说成已经验证的断网恢复失败，也不能说起播问题已修复。

**19:16:11** 独立核对完整用户状态 SHA、源覆盖是否存在、IPv4/IPv6 OUTPUT 规则和显示尺寸/密度均与会话开始一致，最终 APK 仍安装于验证实例。**19:16:54** 只关闭本轮启动的实例 1，核对 Android/进程均停止，恢复开始时的关闭状态。记录见 [tv-session-restoration](evidence/system-audit-2026-11-22/tv-session-restoration.json) / [mumu-session-end](evidence/system-audit-2026-11-22/mumu-session-end.json)；原 APK 和用户状态备份留在忽略目录 `../.tmp/system-audit/tv-original-state/`。

## 仍需改进与验收标准

| 顺序 | 改进项与实际依据 | 后续可验证条件 |
| --- | --- | --- |
| 1 | 大型收藏按需分页、可取消请求、保留已加载条目；10000-ID 契约已对齐，但冷缓存仍逐条读取，TV 缓存小于合法列表 | 对 2501/10000 条列表测首屏、取消、分页顺序和重启后的请求数；失败时首屏已读内容保留，不扩大缓存到无界 |
| 2 | 把目录失败和媒体起播失败分别纳入源稳定性采样；桌面三个目录在原/候选同窗超时，TV 最新 360 probe 多次超时 | 保留逐阶段耗时和原错误；在至少两个网络窗口、可控成功/超时源上验证首帧和重试预算，再决定是否修改策略，不能按单次测试永久禁用来源 |
| 3 | 暂停后立即显示保存的实际时间；目前一秒 UI tick 会令首张暂停截图晚更新 | 媒体键和 UI 暂停后对比原生/保存位置与显示时间，并在稳定窗口内确认无前进；当前暂停稳定性已通过，属于较低影响体验改进 |
| 4 | 补足真实换线、长时播放与低端设备测试；本轮没有第二源样本，只测 MuMu API 35 和短时解码 | 用两个实际可播源验证同位置接管、选择记忆及失败回退；补 TCL / API 22、低内存、长时播放的首帧、丢帧、堆与返回焦点 |

本轮交付是工作区中的四项修复、可执行回归、候选包和审阅证据。它具备复现与验证依据；对尚未得到充分样本的网络、安装和硬件场景，以上结果保留明确边界。
