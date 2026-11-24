# 双端体验与质量排查（2026-11-24）

本轮顺序为分析定位、落地修复、补回归与运行验证。分析基线保存在 `.tmp/quality-audit-2026-11-24/baseline/`；该工作区已有大量修改和用户主动删除的文件，本轮以这份工作区基线为准，不以 Git HEAD 覆盖它。

界面的唯一依据是 `src/renderer`、`tv/app/src/main` 及其当前编译产物。用户主动删除的原型不恢复；旧测试不原样恢复。新的受控数据只用于网络、IPC 等接口边界，界面本身始终使用实际应用代码。

## 第一阶段：问题清单

以下位置指分析基线，按严重级别排序。实测证据位于 [本轮 evidence](evidence/quality-audit-2026-11-24/)；代码推导与实测明确区分。

| ID / 级别 | 所属端、文件与位置 | 复现、实际与期望表现 | 体验影响 | 修复方案、既有问题关系 |
| --- | --- | --- | --- | --- |
| Q01 阻断（干净检出交付） | Windows，`.gitignore:27`；`src/renderer/styles/index.css:2`、`tokens.css` | `git check-ignore -v src/renderer/styles/tokens.css` 命中 `**/*token*`，但实际样式入口直接导入此文件。本机文件存在时能构建，按 Git 交付会缺失必需样式。期望实际前端全部必需文件可交付。 | 干净检出无法完整构建界面；字号、颜色、间距及层级定义丢失。 | 给实际前端路径增加精确例外，保留生产 CSS；更新已失效的原型路径说明。属于迁移后的交付缺口，不恢复原型。 |
| Q11 阻断（TV 编译；最终构建阶段新确认） | TV，`ui/Theme.kt` 的 `emptyOrErrorBox` 参数顺序；`HomeScreen.kt:146`、`DetailScreen.kt:126`、`PlayerScreen.kt` 错误页及 `PersonScreen.kt` 重试 | `gradlew.bat testDebugUnitTest lintRelease assembleRelease` 在 debug/release 均报回调参数过多或 `Function0<Unit>` 被当作 Boolean。分析基线同样把 `focusRetry` 放在 `onRetry` 后面，尾随 lambda 无法绑定回调。期望两种错误页调用形式可编译且重试/焦点功能仍有效。 | TV 无法从当前源码构建，重试页不能交付。 | 把可选焦点参数放在回调前，保留回调为最后一个参数；重新构建并实际激活错误页重试。首轮构建日志保留，不以之前文档的构建结果替代当前结果。 |
| Q02 严重 | TV，`playback/WarmMediaCache.kt:111–145` | 对生产 `SharedSegmentFlow` 开一个 reader，令读线程等待后调用 `close()`。300ms 后线程仍是 `WAITING`；必须额外结束整个流才退出。期望关闭本 reader 即唤醒其阻塞读取，其他 reader 可继续使用。 | 退出或反复切集可能卡在分片读取，拖住播放器释放并占用线程。 | 等待条件包含 reader 的关闭状态；每次关闭都唤醒等待者；保留共享下载及其他 reader 的行为。新缺陷。 |
| Q03 严重 | 共用播放后端 / TV，`src/main/playback/service.ts:637`；`tv/.../playback/PlaybackService.kt:946` | 通过网络响应边界返回 HTTP 200、空 `video/mp4`，或 JSON 错误正文。两端生产选源器均返回可播放 MP4。期望至少实际读取媒体头、拒绝空正文及非媒体内容，再允许该源入选。 | 错误源成为赢家，用户看到黑屏、加载及重复重试，其他可用线路失去先发机会。 | 有限读取 MP4 开头并验证 ISO BMFF 媒体盒；继续支持 200/206、忽略 Range 的正常上游；关闭探测响应，失败交给现有竞速与兜底。新缺陷。 |
| Q04 严重 | 共用播放后端 / TV，`src/main/playback/service.ts:407–421,515`；`tv/.../playback/PlaybackService.kt:557–598,711` | 同一集保持旧 A 请求未完成，再发自动重试并选中 B；随后放行 A。两端实测 `current` 从 B 被改回 A。期望旧请求可向自己的调用者返回结果，但不可覆盖当前请求的线路状态或缓存。 | 菜单选中线路与实际画面不一致；下次重试、切集和偏好状态可能依据错误赢家。 | 每集的新选源任务有独立世代，写入选择、赢家及缓存前检查归属；复用同一缓存任务、其他集的预加载和手动偏好版本仍有效。11-23 的手动偏好修复仍在，本项是自动请求归属缺口。 |
| Q12 严重（验证中新确认） | TV，`playback/PlaybackService.kt` 的 contest 任务登记、stop 和 probe 等待；`net/PublicNetwork.kt` 的连接取消 | 生产选源代码中令 A 的响应头读取阻塞、B 立即返回真实 MP4 头。实测 B 已写为赢家，但 `resolve` 在 700ms 内仍不返回；本轮一个快速并发回归也在 3s 期限失败。原作用域要等取消中的阻塞 IO 子任务，`jobs` 又在锁外登记，可能漏取消后登记的定时任务。期望 B 就绪即可起播，取消同时关闭不用的连接。 | 并发探测选到了好线路，却仍被慢线路拖住；切源、退出和起播期限不稳定。 | 请求继续由现有 service scope 管理，竞速只等待可取消且有期限的结果；登记/取消任务同步，已结束竞速立即取消后登记任务；取消对象关闭连接及迟到的响应。保留赢家首片预热。诊断 JSON 保存为 `tv-cancellation-before.json`。 |
| Q05 严重 | TV，`playback/PandaMediaDataSource.kt:175–181` | 将生产 DataSource 放入“还欠 100 字节、上游已经 EOF”的传输状态，实测 `read()` 返回 `-1`。期望已知响应长度未收齐时抛出 IOException，触发播放器恢复。 | 截断分片会被当作正常结束，可能出现短片、卡顿或 seek 后停住而没有及时重试。 | 区分未知长度的正常 EOF 与已声明长度的提前 EOF，并在关闭时重置读取预算。新缺陷；源探测阶段既有完整性检查不能替代播放中的检查。 |
| Q15 严重（实看画面新确认） | 共用后端 / TV，`src/main/playback/service.ts` 的 `matchRecord`；`tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt` 的同名匹配和 `parseVod` | 在实际应用打开国产《三体》（2023、中国大陆、杨磊），从 360zy 起播。画面、60/63 分钟时长与欧美版对应。真实目录把国产版 58434 和欧美版 57048 都写成 2023 年；两端忽略 `vod_area`，均将欧美版判成强匹配。期望明确冲突的制作地区参与排除，同源的另一版不得入选。 | 播放动作、分集标题和历史都像成功，实际看的是另一部作品；此前闭环证据只能证明动作成功，不能作为正确内容验收。 | 解析源地区，规范常见地区别名，仅排除双方已明确提供且不相交的地区；候选缓存包含地区。保留缺省地区、合拍及已有年份/类型/别名规则。是既有版本匹配覆盖不完整，本轮未将旧“同名翻拍已测”当作当前通过证据。 |
| Q16 严重（同一真实目录新确认） | 共用后端 / TV，`src/main/playback/service.ts`、`tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt` 的 `parseLines` 与编号映射 | 国产《三体》的真实目录有 53 条：10 条彩蛋、30 个正片编号及 13 条编号重复的其他媒体地址。现有规则保留彩蛋并将重复编号退化成位置序列，导致第 1 集指向彩蛋，或在有其他同名记录时让那条记录成为主序列。期望第 N 集对应实际正片第 N 集，同时保留同集其他地址的失败兜底。 | 起播与切集播放彩蛋/错集，详情可播集数不准确；直接删除重复项还会丢掉可用地址。 | 排除明确彩蛋/幕后等非正片条目；对全部明确编号且编号合理的列表，把同编号不同地址分成等价线路，去掉完全相同的重复地址。保留综艺日期、特别篇及位置列表的现有语义。 |
| Q06 严重 | TV / Windows，`tv/.../ui/PlayerScreen.kt:254,625,876,957`；`src/renderer/Player.tsx:493` | 起播未出首帧时暂停/进入后台超过 15s；或 TV 暂停超过 20s 后在缓冲中恢复。代码路径仍计入起播期限、冻结基线或健康窗口。期望暂停及隐藏时不误判失败，恢复后重新获得观测窗口；真实冻结仍有期限。此项由生命周期路径确认，设备回放在最终验证阶段补齐。 | 暂停后意外换源；恢复播放立即重连；暂停/缓冲被算作健康播放，过早清掉失败次数。 | TV 使启动看门狗服从显示与播放意图，恢复时更新进度基线，健康窗口只计算连续播放；Windows 启动期限暂停计时并在恢复后继续。属于既有冻结看门狗的生命周期边界缺口，不重复修改已修的下载掩盖冻结问题。 |
| Q14 一般（加载交互中新确认） | Windows `Player.tsx` 的 play/ready 判断；TV `PlayerScreen.kt` 的 syncButtons | 等待媒体期间已请求自动起播，但 Windows 控件在 ready 前丢弃暂停操作；TV 缓冲时把暂停操作标成播放。期望用户能暂停待起播意图，按钮明确表示当前意图，媒体到达后保持该意图。 | 加载中无法暂缓自动起播，缓冲时的遥控确认含义与文字不一致。 | 播放意图与解码就绪分开；加载期间仍允许暂停/恢复，并直接控制启动预算；seek/PiP 继续等待就绪。TV 的播放按钮用意图及结束状态决定文字。 |
| Q07 一般 | Windows，`src/renderer/Player.tsx:285,525` | 实际应用播放《三体》后暂停、聚焦进度条并按 Up。实测位置保持 `0.123s`，音量从 `0.8` 变为 `0.85`。期望聚焦进度滑块时方向键调整进度，离开滑块后保留全局音量快捷键。 | 键盘操作与滑块语义不一致，用户误改音量；PageUp/PageDown 缺失。 | 进度条自己处理方向、Home/End、PageUp/PageDown，并阻止已处理的键再被全局快捷键消费。新缺陷。 |
| Q13 一般（端到端中新确认） | Windows，`src/renderer/components.tsx` 的 `IconButton` | 加载时 React 传了 `disabled=true`，但 Tooltip.Trigger 的该属性只禁用提示，不设置原生 button.disabled。实际快照中进度条/大播放按钮禁用，底栏播放按钮仍可聚焦点击，点击被播放函数的 ready 检查丢弃。期望状态为禁用的操作真的不可激活、不可进入 Tab 顺序。 | 用户看到可操作按钮却无响应；还会误导以可用状态为前置条件的自动化回放。 | 在 Tooltip.Trigger 的 render 上提供原生 disabled button，并保留 Tooltip 自己的禁用属性；运行加载态、键盘焦点和重新可用后的真实点击回归。Base UI v1.9 文档确认其 disabled 不设置原生属性。 |
| Q08 一般 | Windows，`src/renderer/styles/media.css:693,756` | 实际详情页已观看第 1 集为可点击链接，渲染颜色 `rgba(239,234,226,0.32)`；与实际背景合成后的对比度为 **2.631:1**，字号 14px。期望可操作的集数和分集标题至少 4.5:1。 | 已看集数像禁用项，近距离观看也偏暗，低视力用户难辨认。 | 已观看项使用可读的辅助文字颜色，保留当前集强调及禁用状态的独立颜色；同时覆盖数字格与带标题列表。属于客观可读性缺陷，不更换整套配色。 |
| Q09 一般 | TV，`playback/PlaybackService.kt:815–837` | 并发完成当前候选时，`onDelivered` 先记住 `live.isEmpty()`，随后 `startMore()` 启动排队候选，却仍用旧值立即结算。存在选优提前结束的可达交错；两轮 40 次并发样本均未观察到该交错，不能称为实测必现。 | 在该交错中会选中已完成的低质量/慢源，取消刚启动的更好源。 | 与桌面实现保持同样顺序：补充队列后重新读取实时活动状态；增加队列补位与更好画质候选的行为回归。代码确认的竞态，不是固定首源问题。 |
| Q10 一般 | TV，`ui/PersonScreen.kt:143–154` | 影人基本信息请求保持未完成，作品列表先完成；代码先 `await(infoTask)` 才呈现作品。期望已有影人姓名/头像提示时，作品完成即可浏览，基本信息随后更新。Windows 已分开请求。此项由等待顺序确认。 | 影人页的可用作品被可选信息拖住，额外出现长时间加载。 | 在同一页面生命周期内独立更新基本信息与作品；重试/退出取消两者，部分信息失败不阻断列表。新缺陷。 |

### 既有修复与主观项

验收补充：Q08 的普通已看状态已达 4.76:1，但实际悬停为 4.46:1，原因是已看规则覆盖了 hover 的文字颜色；本轮补齐该状态及带标题的分集回归。Q04/Q15 还需同时约束已解析缓存：只有标题、年份、类型、地区和播放提示一致，且缓存仍属于当前集的最近选择，才可复用；否则可能在元数据更新或清晰度往返后复用旧地址或显示旧线路。以下补充也按先定位、再改实现、最后回归处理。

已核对 `usage-audit`、`usage-fixes-2026-11-23`、`system-audit`、`playback-audit`、`frontend-audit-tv`、`frontend-audit-windows` 和证据审核文档。保存失败/损坏状态恢复、详情共享请求的取消归属、Windows 分页返回记忆、大收藏分批加载、手动线路偏好版本及预加载失效、实际倍速同步、基础详情与可选详情分离、图片缓存约束均仍在当前代码中；不把这些已完成事项重新列为待修。

两端分别评估：Windows 采用实际原生窗口与鼠标键盘路径；TV 采用 960×540 基准缩放、5.3% 安全边距、独立焦点/选中态及遥控返回路径。分析阶段 Windows 设置页在 1080×640、1440×900、125% 和 150% 缩放样本中无横向溢出、无 pageerror。不会因标题大小、卡片密度或阴影偏好改写既有布局。TV 字号、安全区、抽屉、焦点和播放遮挡在最终 APK 上复验，历史截图不作为本轮运行结果。

源配置、广告过滤保护条件、请求超时/重试、DNS 失败恢复、metadata/search 索引、主进程 IPC 与 preload 契约、播放器缓冲/资源释放均纳入审阅。外部目录及元数据服务的临时不可用与本地缺陷分开记录，不能把部分线路失效当成所有线路不可用，也不能以删源方式伪造通过。

## 第二阶段：修复（已落地）

修复按“先定位、再改实现、最后回归”执行；Q11 在实际编译中发现，Q12–Q16 在设备/画面验证中确认。下表把每项映射到当前生产代码与回归入口。

| ID | 生产位置 | 回归 |
| --- | --- | --- |
| Q01 | `.gitignore:27-28` 精确放行 `src/renderer/styles/tokens.css`；`src/renderer/styles/index.css` 保留实际导入 | `tests/production-assets.test.ts`；`npm run build`；最终 asar 271 项，无 source map/测试/脚本 |
| Q02 | `tv/.../playback/WarmMediaCache.kt:104-145` 的 `closed` 条件、每次关闭唤醒及其它 reader 继续 | `SharedSegmentFlowTest` 的 4 个 reader/取消用例 |
| Q03 | `src/main/playback/media-head.ts`；`src/main/playback/service.ts:680-690`；`tv/.../playback/PlaybackService.kt:997-1024` | `tests/media-head.test.ts`、`tests/playback-admission.test.ts` 的空/JSON/非媒体/206 用例；TV `MediaHeadTest`、`MediaAdmissionTest` |
| Q04 | `src/main/playback/service.ts:424-457` 的 `selectionIntent` 与写入前归属校验；TV `PlaybackService.kt:594-634` 的 `SelectionIntent` | `keeps the newer automatic winner...`、`does not let a late manual request...`、TV `MediaAdmissionTest` |
| Q05 | `tv/.../playback/PandaMediaDataSource.kt:144-158` 的声明长度提前 EOF | TV `MediaDataSourceTest` 的两个 EOF 用例 |
| Q06 | `src/renderer/startup-watchdog.ts`；`src/renderer/Player.tsx:371-415,496`；TV `PlayerScreen.kt:891-918,1068-1069` | `tests/renderer-startup.test.ts`；TV `PlayerLifecycleTest`；E2E 首帧前暂停 |
| Q07 | `src/renderer/Player.tsx:309-314,565-578` 的滑块按键与阻止全局消费 | E2E `focused seek arrows and page keys...` |
| Q08 | `src/renderer/styles/media.css:688-758` 的普通/悬停/聚焦已看色 | E2E `watched numbers and titled episodes...`，数字格与带标题列表均 ≥4.5:1 |
| Q09 | `tv/.../playback/PlaybackService.kt:839-861`：`startMore()` 后重新读取 `live.isEmpty()` | TV `MediaAdmissionTest` 的队列补位/更快赢家用例 |
| Q10 | `tv/.../ui/PersonScreen.kt` 的 `loadPersonPage` 独立基本信息与作品请求 | `PersonPageLoadTest` 三例 |
| Q11 | `tv/.../ui/Theme.kt:573-612`：`focusRetry` 在 `onRetry` 前，回调保持尾随参数 | `gradlew testDebugUnitTest lintRelease assembleRelease`（98/98，lint/assemble 通过） |
| Q12 | `tv/.../playback/PlaybackService.kt:950-1024` 的竞速/任务登记；`PlaybackService.kt:487`；`MediaRequestCancellation.kt`、`net/PublicNetwork.kt` 的连接/响应关闭 | `MediaRequestCancellationTest`；`PlaybackSearchTest` 的 fast winner/cancel 用例 |
| Q13 | `src/renderer/components.tsx:40-44`：原生 `button disabled` 与 Tooltip 自己的禁用属性分离 | E2E `loading icon controls have native disabled state...` |
| Q14 | `src/renderer/Player.tsx:191-200` 的 `playRequested`；TV `PlayerScreen.kt:213,894,1068-1069` 的意图/按钮同步 | `renderer-startup`、`PlayerLifecycleTest`；TV 最终 cycle 的 22s 暂停 |
| Q15 | `src/main/playback/service.ts:147-170` 的 `countries`/`COUNTRY_ALIASES` 与 `matchRecord`；TV `PlaybackService.kt:119-197` | `tests/source-identity.test.ts` 的冲突地区/合拍/缺省地区；`tests/playback-admission.test.ts` 缓存含地区；TV `SourceIdentityTest` |
| Q16 | `src/main/playback/service.ts:242-270` 的彩蛋排除、编号镜像拆分；TV `PlaybackService.kt:289-308` 的 `EP_TRAILER_RE` 与镜像 | `source-identity.test.ts` 的镜像/日期/特别篇；`playback-admission.test.ts`；TV `SourceIdentityTest`、`GoldenParityTest` |

## 第三阶段：测试、构建与实际验证

以下均为本工作区当前代码在 2026-11-24 实际执行的结果；完整指标、日志和截图索引见 [final/manifest.json](evidence/quality-audit-2026-11-24/final/manifest.json)。

### 3.1 验证基线

- 桌面生产构建：`npm run build` 于 20:08 完成（`out/main/index.js`、`out/preload/index.js`、`out/renderer/`）；新增的 `PANDA_E2E_SHOW_INACTIVE=1` 只改变测试窗口的显示方式，不设置时仍正常聚焦。
- 最终 Windows unpacked：`.tmp/quality-audit-2026-11-24/windows-package-final-green/win-unpacked`；`app.asar` SHA-256 `8FFF87B5…40E3EB`，271 项，无 node_modules/测试/e2e/脚本/source map；`Panda.exe` SHA-256 `89CA17B1…FD6B26`。
- 最终 TV APK（含非凡资源新 API）：1,846,722 字节，SHA-256 `7688BF38BFE8DBD751B485A6898B32EDF18ADC9917FC43B756E33820D798AB3B`，versionCode 15 / versionName 1.0.14 / minSdk 22。

### 3.2 桌面构建、单测与端到端

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| `npm run typecheck` | 通过；包含 `e2e/**` 的最终测试辅助改动 | `final/typecheck-final-green.txt`、`final/typecheck-final-after-harness.txt` |
| `npm test` | **36/36** 通过 | `final/vitest-final.json` |
| `npm run test:release` | **6/6** 通过 | `final/release-tests-final.txt` |
| `npm run test:e2e:fixture` | **10/10** 通过（`PANDA_E2E_SILENT_OUTPUT=2 PANDA_E2E_SHOW_INACTIVE=1`，静音且测试窗口不抢焦点，1.4 分钟）；包含此前失败的 test 5 原生禁用态与 test 7 真实 HLS 切集/切源/seek/全屏/退出/重进，以及失败源兜底、暂停预算、对比度、搜索/收藏/离线重试、6 次退出资源释放 | `final/fixture-10-green-muted-inactive.txt`、`final/fixture-green/` 逐用例 JSON/截图 |
| `npm run test:e2e`（真实网络） | **2/2** 通过（同样静音、不抢焦点）；起播 4.947s、seek 0.480s、92 帧、退出保存第 2 集 63s、重进 63.889s；当前只有 360zy 返回目录，切源不可用 | `final/live-2-green-muted-inactive.txt`、`final/live-green/` |
| 打包候选联网 E2E | **2/2** 通过（`PANDA_E2E_EXECUTABLE` 指向 final `Panda.exe`，同样静音、不抢焦点）；起播 4.587s、seek 1.133s、93 帧、重进 63.886s | `final/packaged-live-2-green-muted-inactive.txt`、`final/playwright-packaged-live-final-green.json`、`final/packaged-live-green/` |

排障记录：修复前的打包/静音批次在“下一集”点击和 `page.screenshot` 超时处失败。用最终打包应用做命中诊断后确认：指针静止时控制层进入 `data-idle`，视频层位于其下并会拦截未先悬停的合成点击；`page.screenshot` 在非前台窗口上也可能等待不到合成帧。诊断记录见 `final/player-idle-hit-diagnostic.txt`。修复分为三处：E2E 先把指针移到控件框内唤醒控制层，等 `data-idle` 清除后再点击；截图在 10s 后回退到无 surface 的 CDP 捕获；主进程在 `PANDA_E2E_SHOW_INACTIVE=1` 时用 `showInactive()` 显示测试窗口，不夺取用户当前焦点。修复后完整 fixture **10/10**（含 test 5/test 7）、真实网络 **2/2**、打包候选 **2/2** 全绿；早期失败日志仍保留为 `final/packaged-live-default-failure-1.txt`、`...-2.txt`、`final/packaged-live-hover-failure.txt`，没有从证据中删除。

### 3.3 TV 构建与设备验证

| 项目 | 实际结果 | 证据 |
| --- | --- | --- |
| `testDebugUnitTest lintRelease assembleRelease` | **98/98** 通过，21 个测试类，lintRelease 与 assembleRelease 通过 | `final/tv-build-final.txt`、`final/tv-unit-summary-final.json` |
| 完整播放闭环 | 起播 6.832s → 第 2 集 → seek 3.451s → 暂停 22s → 退出保存第 2 集 66s → 重进 01:06；最终 APK，真实网络/解码 | `final/tv/cycle-final/report.json` 及 8 张截图 |
| 完整闭环（含受控切源） | 同一次最终 APK 运行：起播 5.959s → 第 2 集 → 切到“360资源镜像” `00:08` → seek `01:09`（2.756s）→ 暂停 22s → 退出保存 72s → 重进 `01:13`；临时规则覆盖给同一真实 360zy 上游增加第二入口，不是两个独立上游 | `final/tv/cycle-mirror-final/report.json`、`rules-fixture.json` 及阶段截图 |
| FHD 布局/焦点/安全区 | **8/8**：顶部导航、频道记忆、详情返回、频道缓存淘汰、辅助点击、片库根返回、确认弹层、键盘返回；1920×1080，5% 安全内边距 | `final/tv/surfaces-1080/report.json` |
| 720p 布局 | **3/3**：bezel、确认弹层、键盘返回；1280×720 | `final/tv/surfaces-720/report.json` |
| 4K + 字体缩放 | **3/3**：bezel、确认弹层、键盘返回；3840×2160、`font_scale=1.15` | `final/tv/surfaces-4k-font/report.json` |
| 扩展导航与片库 | **8/8**：搜索结果回顶、搜索末行保持列、影人作品回顶、搜索/影人流程、收藏列表回顶、收藏详情返回、历史列表回顶、收藏/历史流程；用户与片库状态恢复 | `final/tv/navigation-final/report.json` |
| 搜索取消 | **3/3**：刘德华/西游记/蜡笔小新，清空输入后 12s 内待定结果不反扑 | `final/tv/search-state-final/report.json` |
| 焦点/滚动动画 | **4/4**：首页 179–182 帧、p95 17ms、1 个 jank（0.55%）；展开频道 271–284 帧、p95 6ms、0 jank | `final/tv/motion-final/report.json` |
| 播放错误恢复 | 断网后 40.259s 显示“连接超时，请重试”，重试 4.510s 恢复到第 2 集真实播放 | `final/tv/error-final/report.json` |
| 准入取消 | 查找片源弹层焦点锁定、“取消”返回焦点到播放按钮、无残留遮挡 | `final/tv/admission-final/report.json` |
| 媒体键/控层 | MEDIA_PAUSE/PLAY、D-pad 唤起、菜单隐藏、1.25s 长按确认只触发一次；自动隐藏 2.873s | `final/tv/media-final-report.json` |
| 反复退出/资源 | 6 次同进程播放→返回：ViewRootImpl 1、Activity 1、PID 不变；Java/Native PSS 在样本内无累积 | `final/tv/lifecycle-final-report.json` |
| 5 分钟连续播放 | 301.85s，时间轴 3→303s；渲染 7624 帧、丢帧 0、跳过 0；6 次堆采样稳定 | `final/tv/long-final/report.json` |

TV 切源：更新 **非凡资源 ffzy** 的接口（`https://cj.ffzyapi.com/...` → `https://api.ffzyapi.com/api.php/provide/vod`）并重建 APK 后，最终 APK 在《八仙！》上完成 **360资源 ↔ 非凡资源 独立真实切源**：脚本选中“360资源”，时间轴从 `00:02 / 2:23:16` 保持到 `00:07 / 2:23:16` 并继续播放，用户状态与防火墙恢复。逐源真实播放结果见[全量片源排查](source-playback-audit-2026-11-24.md)：当前 360zy 与更新后的 ffzy 可播放；电影天堂、虎牙、金鹰、红牛、速播、暴风、量子等仍在目录前不可达，未通过删源或改配置伪造。为验证最终 APK 自身的切源 UI/状态机，临时推送源规则覆盖，在保持同一真实 360zy 上游的前提下增加第二个入口（`api` 加 `?mirror=1`，名称“360资源镜像”）；应用加载覆盖规则后，脚本实测从“线路: 360资源”切到“线路: 360资源镜像”，切换前时间轴停留 `00:03 / 1:00:35`，切换后 `00:04 / 1:00:35` 继续播放，用户状态与防火墙恢复。该样本证明最终 APK 的线路选择、状态保持和恢复播放路径可用，但**不是两个独立真实上游之间的切换**；同一覆盖下完整 cycle 也在一次运行中完成起播→第 2 集→切到“360资源镜像”→seek→暂停→退出→重进（起播 5.959s、切源 `00:08`、seek `01:09`/2.756s、退出 72s、重进 `01:13`）。证据为 `final/tv/switch-mirror-final/report.json` 与 `final/tv/cycle-mirror-final/report.json`、`rules-fixture.json`。独立切源仍以 q16 近邻 APK（SHA-256 `0B426A40…559B`）在 12:42 实测切到“金鹰资源”为支持证据，q16 与最终 APK 的差异是后续已解析缓存归属约束。`final/tv/switch-final-green/report.json` 与 `final/tv/switch-duplicate-final/report.json` 保留为两次 UNAVAILABLE 记录。

### 3.4 线路选优、失败兜底与缓存

- 单测覆盖：`tests/playback-admission.test.ts` 的“空/JSON/非媒体响应被真实 MP4 击败”“晚到的自动赢家不覆盖新请求”“晚到的手动请求不覆盖新自动回退”“手动偏好保留并让下一集预加载失效”“按实际更好画面选 HLS，而不是第一个低画质响应”“缓存质量不能恢复旧线路而留下新选中源”；`tests/source-identity.test.ts` 的地区冲突、合拍/别名/缺省地区、镜像编号与日期特例；TV `MediaAdmissionTest`、`PlaybackPreferencesTest`、`PlaybackSearchTest`、`SourceIdentityTest`、`GoldenParityTest` 与桌面规则对齐。
- 真实桌面 E2E：受控源中“线路甲”故意失败后回退到 c，同时保持播放位置与 `sources.current=c`；`real HLS` 用例切到“线路乙”，画面宽度 1920→1280，证明成功切源；真实网络只有 360zy，切源不可用但播放/切集/seek/退出/重进完整。
- 广告/无效分片：`npm run audit:ads` 结果仍为 93 行、36 份可读清单、3 个过滤、0 个短 discontinuity；360zy《三体》首/中各移除 12 段共 52.701s。jyzy 首帧存在片源烧录的博彩文字，清单层面无法去除；不声称所有源无烧录广告，也未删除原视频段落。

### 3.5 后端与共用逻辑

`tests/backend-quality.test.ts`、`tests/media-head.test.ts`、`tests/playback-admission.test.ts`、`tests/renderer-startup.test.ts`、`tests/source-identity.test.ts` 与 TV 的对应单测覆盖：请求取消不互相污染、畸形响应不缓存、超时类型化、并发上限、私网/带凭据 URL 拒绝、去广告保护加密与多轨、首字母检索、媒体头验证、请求世代、彩蛋/镜像、地区冲突、暂停预算。`resources/play-sources.json` 本轮未修改，未通过删源或改超时伪造通过。

### 3.6 台架与设备恢复

TV 验证使用 MuMu Android 15（API 35）串行重放。结束后已恢复原始 APK（SHA-256 `59EA7C00…1401`）、原始用户状态（`a6154828…2d67`）与显示设置（1080×1920 / 280 / font_scale 1.0）；各脚本的 `userStateRestored`、`firewallRulesRestored` 均为 true。Windows 未安装/升级用户现有安装，仅在 `.tmp` 使用 unpacked 候选。

## 第四阶段：残留风险与结论

本轮 Q01–Q16 均已在生产代码中落地，并由 Vitest、TV JUnit、受控网络/真实网络 E2E、TV 最终 APK 的布局/导航/播放/资源重放覆盖。未发现未修复的已知代码缺陷。仍需明确保留的边界：

- **TV 最终 APK 的独立真实切源已验证通过**：更新 ffzy API 后，最终 APK 在《八仙！》上从“非凡资源”切到“360资源”，时间轴 `00:02 → 00:07` 保持并继续播放；此前的受控第二入口完整闭环仍保留为状态机证据。当前仍不可达的源（电影天堂、虎牙、金鹰、红牛、速播、暴风、量子）是上游 403/超时/连接重置，不是应用播放缺陷。
- **实体音频输出未验证**：桌面 E2E 使用 `--disable-audio-output` 静音运行，断言解码帧、时间轴、暂停/恢复与历史，不证明扬声器可听，也未做人耳/声卡测量。
- **实体 TV 未验证**：仅在 MuMu Android 15 运行；API 22 由 minSdk、lintRelease 与静态兼容检查保障，未在 TCL Android 5.1 真机重放。
- 外部片源与豆瓣接口无可用性承诺；本轮 403/超时是真实上游状态，不写成产品永久结论，也不以改源配置规避。

所有日志、截图、指标 JSON 按端归档在 [evidence/quality-audit-2026-11-24/final](evidence/quality-audit-2026-11-24/final/)，入口为 [manifest.json](evidence/quality-audit-2026-11-24/final/manifest.json)。