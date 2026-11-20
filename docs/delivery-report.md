# Panda 交付报告

2026-11-21（桌面 1.1.2；TV 1.0.12）。本轮强化线路切换时的画面保留、失败恢复和倍速帧率适配，扩充频道布局与真实播放回归，并重验 Windows 安装包与 TV APK。实际运行数据和仍受上游线路影响的样本见下方“1.1.2 发布验收”；既有版本记录保留作历史对照。

## 启动方式

桌面端需要 Node 24、Windows 10/11 x64；电视端构建需要 JDK 17+（本机 JDK 21）与 Android SDK（`local.properties` 指向本机 `E:\dev\android-sdk`）。

| 目的 | 命令 |
| --- | --- |
| 安装依赖 | `npm install` |
| 开发运行 | `npm run dev` |
| 类型检查 / 离线单测 | `npm run typecheck` / `npm test` |
| 桌面 E2E（需联网，先 `npm run build`） | `npm run test:e2e` |
| 生成桌面安装包 | `npm run dist` → `release/Panda-1.1.2-Setup.exe` |
| 构建并校验 Android TV 包 | `cd tv && .\gradlew.bat testDebugUnitTest lintRelease assembleRelease` → `release/Panda-TV-1.0.12.apk` |
| 导出双端对齐黄金向量 / 播放器回归 | `node scripts/export-tv-vectors.mjs` / `python scripts/verify-tv-playback-transitions.py --case all` |
| TV 列表 / 搜索 / 动画回归 | `python scripts/verify-tv-navigation.py --extended --library` / `python scripts/verify-tv-search-state.py` / `python scripts/verify-tv-motion.py` |
| 重放线上审计 | `npm run probe:filters`、`npm run probe:sources`、`npm run audit:ads`、`npm run probe:start`、`npm run probe:startup` |

安装包为按用户安装的 NSIS 程序，默认安装到 `%LOCALAPPDATA%\Programs\Panda`（安装向导里可改目录；再次安装会沿用上次的目录原地升级），创建开始菜单与桌面快捷方式，可从“应用和功能”卸载，卸载保留 `%APPDATA%\Panda` 里的收藏与历史。

## 环境变量

全部可选，不设置即为正常使用方式。应用不需要任何密钥、Cookie 或账号。

| 变量 | 作用 |
| --- | --- |
| `PANDA_USER_DATA_DIR` | 改用指定目录保存收藏、历史、设置（测试用它隔离数据） |
| `PANDA_SOURCE_CONFIG` | 用指定的 `play-sources.json` 取代内置片源与去广告规则 |
| `PANDA_UPDATE_URL` | 返回 `{ "version": "x.y.z" }` 的 HTTPS 地址；未设置时“检查更新”提示“更新服务未配置” |

不改环境变量也可以更新规则：把通过校验且版本不低于内置的 `play-sources.json` 放进用户数据目录即可，规则从不联网拉取。

## 架构

`渲染进程 React → 类型化 preload 桥（window.panda）→ Electron 主进程 → 豆瓣适配 / 片源解析 / 缓存 / 本机媒体代理`

- 渲染进程开启 sandbox 与 contextIsolation，只拿到契约类型的数据和本机 loopback 上的不透明资源句柄；构建产物 `out/renderer`、`out/preload` 中不含任何上游主机、接口路径或 Cookie 字样。
- 请求、归一化、缓存、限流重试、播放解析、去广告、DNS 校验全部在 [src/main](../src/main/)。
- 界面直接引用原型的 CSS、文案、图标、字体与契约类型；`design/` 206 个文件 SHA256 未变，`design/mock|art|preview` 不进入发行包。
- 选型与理由见[实现清单](implementation-plan.md)，各项取舍见[决策记录](../.agents/notes/implemented/architecture/)。

## 数据链路

豆瓣移动端官方接口（无凭据）→ 形状校验 → 归一化为契约类型 → 按端点缓存（列表 10 分钟、搜索 2 分钟、详情 24 小时）→ IPC。并发上限 4，同请求合并，瞬态错误退避重试一次；错误按离线 / 超时 / 限流 / 上游异常分类后显示并可重试，不回退到任何内置数据。缺失字段直接不显示。

- 首页栏目与榜单、频道、搜索、联想、详情、演职员、影人作品、剧照、相关推荐均为真实数据；热搜来自百度电影榜与电视剧榜（豆瓣没有影视热搜接口）。
- 详情页的演职员是豆瓣详情页自己用的主要演职员名单：最多 8 人（导演、最多 6 位主演、其他部门负责人），带照片；点其中一人列出他的全部作品（按评分从高到低，每次 30 部，滚动加载）。[记录](../.agents/notes/implemented/architecture/2026-11-17-people.md)
- 频道筛选共 736 项（类型 / 地区 / 年份，每频道 127–171 项），2026-11-20 实测 736/736 有内容。
- 细节与实测见[豆瓣审阅](douban-audit.md)。

## 播放链路

豆瓣条目（片名、年份、分类、别名、集数）→ 9 个片源同时检索（限流容量 12；找到后最多再等 1.2 秒，不等最慢的）→ 身份匹配 → 按集号对齐各源线路 → 3 个源同时起播比较：先看首片的实际传输余量，再比较真实画面 → 本机代理（清单改写、去广告、分片 / 密钥转发）→ hls.js / 原生 video。TV 源池保持相同的 12 个搜索槽，避免排在末位的回退目录在前八个请求迟滞时无法启动。

- 身份以“名称 + 年份 + 分类”互证；豆瓣按年拆分的长篇连载用别名里的集数区间映射到片源的累计记录。
- 片源表 v3：速播、虎牙、暴风、电影天堂、量子、非凡、红牛、金鹰、360；本次新增速播、虎牙、红牛，停用飘零（接口关闭），极速仍停用。依据是在北京服务器上的实测，见 [cn-sources.md](evidence/cn-sources.md)。
- 选源不靠固定排名：以媒体时长与实际下载耗时估计播放余量，至少 1.25 倍的源优先，再比较从首片读到的实际画面；已经测慢的源排后。慢的源 2.5 秒让位，会话内记住当前网络的表现。清晰度标签仍来自实际画面；一次测量不能保证之后永不卡顿。[记录](../.agents/notes/implemented/architecture/2026-11-17-source-contest.md)
- 失败、超时或余量不足的源按“作品 + 源”延后 10 分钟，不污染其它作品；下一集优先复用上一集赢家，同时保留替代源竞速。桌面 hls.js 使用 `LoadPolicy` 短重试与 90/180 秒前向缓冲、30 秒回看缓冲；TV Media3 按内存使用 10--30 秒或 12--48 秒缓冲，起播看门狗以首帧输出为准，缓冲后 2 秒重新起播。倍速按真实解码帧窗口降速并逐步恢复。[记录](../.agents/notes/implemented/architecture/2026-11-19-playback-stability.md)
- 起播实测（每频道热门前几部的第 1 集，搜索 + 选源 + 清单 + 首片）：北京 31/32，中位 2.6 秒，27 部 1080P；开发机（境外出口）23/24，中位 1.7 秒。两处唯一没播成的是同一部各源都没有收录的综艺。
- 播放器：选源失败先自动再要 2 次才提示；起播 15 秒无画面或中途 20 秒不动自动换源（最多 2 次）并回到原位置；可在“线路”菜单手动换源；提前选好下一集的源。
- 播放器的播放 / 暂停、进度与缓冲、音量、倍速、清晰度（片源真有多档时）、选集、全屏、画中画、下一集、出错重试均接真实媒体状态；重试会换源。
- 实测覆盖（真实详情 → 匹配 → 解析第 1 集并读到媒体数据，2026-11-17 15:41）：剧集热门前 14 条 14/14，电影 12/14，动画 14/14，综艺 13/14，纪录片 9/14；六个长篇连载的 48 个豆瓣条目 44 个可播，其中带集数区间的分年条目 32/33。未通过的 12 条都是各源答复“没有收录”的条目（含尚未上线的）。
- 细节见[播放审阅](playback-audit.md)。

## 2026-11-19 播放稳定性验收

- 真实源覆盖：`npm run probe:sources` 于 23:11（UTC+8）完成，热门 TV/电影/动画均 14/14，综艺 12/14，纪录片 10/14，六组长篇连载 44/48，带集数区间 33/34；完整记录见 [source-coverage.json](evidence/source-coverage.json)。未据此全局删除目录，因为本机出口在境外，失败包含目录 403、TLS 和超时。
- 境外出口起播探针：`npm run probe:start` 于 23:14（UTC+8）运行 16 个热门条目，13 个读到首片；成功样本总耗时中位数 4,188 ms，最慢 9,910 ms，获胜源 360zy 13 次。该结果只描述本机出口，不替代国内源结论。
- 离线检查：`npm run typecheck`、`npm test`（15 个文件、234 个测试）、`npm run verify:design`（206 个设计文件未变）和 `node design/tools/test-contract.mjs`（405 项）均通过。
- TV release APK：最终发布文件 `release/Panda-TV-1.0.3.apk`，1,068,444 字节，SHA-256 `6112B93C49BA76EC9C7C22E2935564F403DEA8F5404DC3351D56F797542EDEDB`，v1/v2 签名通过，证书 SHA-256 `d49e8eaee47712b2dac54444ef627d53fd2bf302ddc67ecdcbd3d8d695073fcd`。
- TV 真实回归（MuMu Android 15，1.0.3，2026-11-20 00:57--01:06）：重复完整导航、搜索、播放器焦点与切集、无源重试均通过；用户状态和防火墙规则恢复标志均为 `true`。导航第一次重放有一项综艺焦点边界偶发失败，立即完整重跑后全部通过。动画两轮共 4 个场景均为 0 卡顿帧、p95 5 ms。详见 [navigation](evidence/runtime/tv-navigation/playback-stability-1.0.3-repeat/report.json)、[search](evidence/runtime/tv-navigation/playback-stability-1.0.3/report.json)、[playback](evidence/runtime/tv-playback/playback-stability-1.0.3/report.json)、[motion](evidence/runtime/tv-motion/playback-stability-1.0.3/report.json)。
- 播放源排序的独立复现先将共享排序设为中性值：新增“下一集先试上一集赢家”的同一测试由通过转失败（先打开慢源 `one`）；恢复正式排序后，同一测试通过。工作级失败降权有独立测试，确认不影响其它作品。
- 最终桌面包的全量 E2E 为 16/19 通过：真实电影、剧集、动画、自动换线与其余界面 / 数据用例通过。其余 3 项是在强制 `bfzy`、`dyttzy`、`lzi` 单源模式下等待解码播放时超时；这些用例会先起播、再验证跨广告剪切点和 seek 后续播，但失败上下文不足以确定具体超时在哪个阶段。同类 `360zy` 用例通过。不能将失败归因到某一阶段或推广成国内网络结论，也不能把本轮完整 E2E 记为全绿。详细结果见[本次验收记录](evidence/playback-stability-checks.txt)。

## 当前发布包（2026-11-21，桌面 1.1.2 / TV 1.0.12）

- 桌面安装程序：[Panda-1.1.2-Setup.exe](../release/Panda-1.1.2-Setup.exe)，133,204,226 字节，SHA-256 `81231C2397F59F2E7ADAF94C34BA93989AB45036F33DAF0ED77422ECF23A5C8D`。已原位升级既有 1.1.1；安装记录为 [install-1.1.2.txt](evidence/install-1.1.2.txt)，asar 271 项，不含 node_modules、原型 mock/art/preview、测试、脚本或 source map。该机器已有用户安装未卸载，未清除用户资料。
- TV 安装包：[Panda-TV-1.0.12.apk](../release/Panda-TV-1.0.12.apk)，1,812,339 字节，SHA-256 `8AD82282BDDA56C1203F06685734FEBD2874E2C57128E6D646EE35C1C4D8E974`，versionCode 13、minSdk 22；v1/v2 签名通过，证书 SHA-256 `d49e8eaee47712b2dac54444ef627d53fd2bf302ddc67ecdcbd3d8d695073fcd`，MuMu 安装了此 APK。
- `npm run typecheck`、`npm test`（19 个文件、282 项）、`npm run verify:design`（206 个文件不变）、405 项原型契约检查和 TV `testDebugUnitTest lintRelease assembleRelease` 通过。发行包验证详情见[1.1.2 发布验收](#2026-11-20-112-发布验收)。

## 2026-11-20 1.1.2 发布验收

- **播放与界面回归**：已安装 Windows 1.1.2 的完整 Playwright 为 26/32；fixtures 与布局为 19/19，通过三种窗口尺寸检查筛选展开、分页后回顶，以及主页面、浮层和播放器。发行版 6 项失败中，3 项强制单源广告播放没有解码首帧，真实剧集和动画也未读到可解码帧；真实电影以 2×播放的 12 秒观察窗仅前进 3.72 秒，未达到测试的 6 秒门槛。未据此宣称全量播放验收通过。
- **启动**：实际安装包 20 次冷启动中位数 995 ms、p95 1,310 ms、最慢 1,489 ms；首屏 18 张可见海报完整解码中位数 1,218 ms、最慢 1,694 ms；完整首页中位数 1,924 ms、最慢 2,484 ms。3 次同目录启动首页数据中位数 607 ms。对照同机 1.1.1 的冷启动中位 1,369 ms、首屏海报 2,989 ms、首页 2,256 ms、复用启动 791 ms；本轮 20 次里有 1 次首页主推标题探针未命中，但仍见 18 张图片加载。原始数据见 [startup-timing-1.1.2.json](evidence/runtime/startup-timing-1.1.2.json) 和 [startup-timing-1.1.1.json](evidence/runtime/startup-timing-1.1.1.json)。
- **源与广告**：频道筛选实测 736/736；热门 2026 样本片源覆盖为剧集、电影、动画各 5/5，综艺 3/5、纪录片 2/5；六组长篇 44/48，带集数区间 31/32。境外出口默认线路首片探针 14/16，中位 2,820 ms、最慢 8,225 ms。当前去广告审计记录 87 条采样，读到 35 份清单；其中 1 份有清单内证据并删除 12 段（52.701 秒），另有 52 条搜索或网络失败，未留下无证据的短块。实时结果受出口、第三方收录变化影响，不能代表国内网络持续可用。
- **TV 遥控器与播放器**：最终 `1.0.12` APK 在 Android 15 MuMu 上完成 23 个导航 / 筛选 / 收藏历史场景、3 次搜索清空和 4 个动画场景；全部通过，动画 0 卡顿帧、p95 5 ms，报告见 [navigation](evidence/runtime/tv-navigation/final-1.0.12-navigation/report.json)、[search](evidence/runtime/tv-navigation/final-1.0.12-search/report.json)、[motion](evidence/runtime/tv-motion/final-1.0.12-motion/report.json)。最终 `1.0.12` APK 的 episode-switch 红绿复现均通过：切集后时间轴从 `00:00 / 00:00` 恢复到第 3 集 `00:02 / 53:29`，再暂停并写入第 3 集历史，状态与防火墙规则恢复为 `true`，详见 [release-hash episode-switch](evidence/runtime/tv-playback/progress-watchdog-final-1.0.12/report.json)。2×观测媒体前进 20 秒、墙钟 12.55 秒；无缓冲窗口的有效播放速度约 2.03×，末尾发生缓冲后策略把活动速度降到 1.5×，MuMu 仍未提供解码帧回调计数，详见 [adaptive speed](evidence/runtime/tv-playback/progress-watchdog-speed-adaptive-1.0.12/report.json)。真实《流浪地球2》由 360 切到金鹰的一轮测试保留画面与 3 秒时间轴并恢复至 5 秒；第二轮因目录只返回一路而标为不可测，详见 [line switch](evidence/runtime/tv-playback/final-1.0.12-movie-line-switch/report.json)。
- **尚未验证**：TV 的真实多线路切换在最终 APK 上只成功复现一轮；未在 TCL Android 5.1 电视、低端 PC 或低端 TV 上测硬解掉帧、数小时播放和温度/内存；也未验证完整桌面卸载循环、国内源的当日实测或第三方源长期稳定。桌面安装包无代码签名，应用自动更新服务未配置。

## 去广告规则审查结果

参考项目的规则绑定“已验证 CDN 域名”并带到期日。复审结论：各源都在轮换 CDN 域名，名单几周即失效（早期抽查的 82 份线上清单只过滤了 15 份）；到期后规则静默全关；带 AES-128 的清单被整份跳过，而广告正是插在加密正片里的明文块。

现行规则（片源表 v3，判定方法与 v2 相同）只认清单内的证据：闭合的 CUE 区间、CMS 广告标记、源专用广告目录、截帧确认过的时长指纹、正片目录之外的短块；逐段跟踪密钥，只在不影响解密时删除。直播、BYTERANGE、MAP、未闭合区间、删除比例超过 15%、单块超过 90 秒时整份原样返回。

| 源 | 采样项 | 读取清单 | 过滤 | 网络错误 |
| --- | ---: | ---: | ---: | ---: |
| 360zy | 11 | 7 | 1（目录外短块） | 4 |
| bfzy / dyttzy / ffzy / hongniu / lzi / subo | 各 8 | 0 | 0 | 各 8 |
| huya / jyzy | 各 14 | 各 14 | 0 | 0 |

当前证据（2026-11-20 17:44，`system route`）共 87 条采样记录，读到 35 份清单，过滤 1 份、删除 12 段（52.701 秒），52 条搜索或网络请求失败；没有留下待证短块。此前 2026-11-17 的完整网络窗口记录为 123 条采样、118 份清单、55 份过滤和 22 份保留短块，随线上内容变化，仅作历史对照。起播、跨删除点拖动、继续解码在有广告的源上仍以对应 E2E 记录为准。

## Android TV 版本（Android 5.1+）

针对客厅电视 TCL L55P2-UD（Android 5.1 / API 22，晶晨 T968 四核 Cortex-A53，1.5 GB 内存，8 GB 闪存，55 英寸遥控器交互），在 [tv/](../tv/) 下采用原生 Kotlin + Android Views + Leanback 焦点网格 + Media3 ExoPlayer `1.8.1`（支持 API 22 的最后一代分支）独立实现，当前包为 [Panda-TV-1.0.12.apk](../release/Panda-TV-1.0.12.apk)（[决策记录](../.agents/notes/implemented/architecture/2026-11-18-android-tv.md)）：

- **体积与签名**：不引入 WebView、JS 引擎、跨端框架或 `.so` 原生库；开启 R8 压缩、资源压缩与中文语言过滤（`localeFilters`），v1 + v2 双签名（Android 7.0 以下必须含 v1 签名），同时声明 `LAUNCHER` 与 `LEANBACK_LAUNCHER` 入口及电视横幅。当前 release APK 为 1,812,339 字节（约 1.73 MiB），单 DEX，全架构通用。
- **老系统与小内存 / 小闪存 / 滚动帧率优化**：内置当前 Mozilla 根证书束（140+ 根证书）与系统证书库组合校验，保留底层 Conscrypt SNI 并在后台线程异步初始化 TLS 1.2，不阻塞冷启动首帧；针对 Android 5.1 Bitmap 占用受管 Java 堆的特性，海报按显示尺寸降采样并以 `RGB_565` 解码，限制并发解码并在回收视图时立即取消陈旧加载任务，无锁读取磁盘图片缓存，关闭焦点动态阴影投射并采用增量分页（`notifyItemRangeInserted`）；首片 `.ts` 预热数据在播放器读取后立即释放，低内存设备使用 16 MiB、10--30 秒缓冲，普通设备使用 32 MiB、12--48 秒缓冲，起播/重缓冲阈值为 1/2 秒；磁盘图片缓存封顶 36 MB、元数据缓存封顶 4 MB；自定义图标与开关零 `onDraw` 对象分配。
- **双端逻辑对齐与原生 TV OS 10 英尺布局**：豆瓣元数据、736 项筛选词表、主要演职员头像与影人全部作品、百度热搜、9 源并发检索、身份匹配、首片真实分辨率竞速与清单内证据去广告在 `PandaMediaDataSource` 内 1:1 复现，经 TypeScript 导出的黄金测试向量单测锁死一致。界面以 `960×540` 屏幕实际像素比例单位锁定布局与字号（免疫非标电视系统 DPI 与大字体缩放溢出），全局统一 `4.8%` 防过扫描安全边距与安全裁剪框（杜绝屏幕边缘半截溢出），悬浮胶囊顶栏、单列 `VerticalGridView` 首页（从下方任意栏目按上键必定完整回到轮播图）、置顶裁剪二级筛选栏（滚动影片绝不遮挡或嵌在海报下方）、居中卡片式加载提示、唯一 2dp 遥控器光标环、3×13 遥控器快捷输入面板、全屏连续左右快进锚定进度条与线路面板默认聚焦在播源。

## 本次 TV 交互修复（1.0.2）

- **列表回顶与位置**：固定卡片行高，方向键按行列导航；完整显示首行之后才进入筛选栏，保留所在列，处理不完整末行与分页。相同规则覆盖五个频道、展开筛选、搜索、影人作品、收藏和历史；收藏详情返回保持原影片与滚动位置。
- **遥控器与动画**：首页榜单左右移动限制在榜单内部，最左/最右边界不再跳入顶栏；视频层不抢按钮焦点，播放器控制栏重新显示时恢复实际按钮焦点。焦点过渡缩短为 95 ms，页面和筛选栏过渡为 120 ms，快速连按跳过中间动画，回收卡片取消陈旧图片请求。清空搜索后取消未完成查询，迟到结果不会覆盖发现页。
- **播放前查源**：保留豆瓣详情，先确认片源和目标集数，再进入播放器；确认无源显示“该影片没有片源，请稍后再试”，网络失败显示重试，检查最多等待 22 秒。真实空目录界面验收临时只启用红牛目录（其他目录当时有超时），使用真实豆瓣作品和真实响应，结束后恢复配置；默认全源的网络失败路径也已实测。
- **立即切集**：选择下一集或选集立即停止旧视频与声音、清空进度和画面、切换标题，再加载新集；连续选择以最后一集为准，观看历史记录实际播放的集数。旧版两次保留旧时间轴；新版两次完成第 3 集实际播放与对应历史。
- **播放首片竞态**：修复预热下载已结束、播放器稍晚开始读取时得到空分片的问题；保留同一份字节给迟到读取者，读完释放。

取舍与已撤回的验收误判见 [TV interaction](../.agents/notes/implemented/architecture/2026-11-18-tv-interaction.md)。下表记录 1.0.2 的交互验收历史；当前 1.0.3 的回归证据见本报告的 11 月 20 日记录。旧版的多密度、起播时长和帧率保留在 [tv-verification.json](evidence/tv-verification.json)，不作为当前包的测量结果。

## 已修复的问题

接手时类型检查不通过、没有桌面入口和播放器。除补全功能外，实测中发现并修复的问题：

| 问题 | 处理 |
| --- | --- |
| 本机代理把图片域名解析成保留地址，海报全部 502 | 主进程经 HTTPS 解析真实地址并固定连接，[记录](../.agents/notes/implemented/architecture/2026-11-16-safe-proxy-dns.md) |
| 确认弹窗打开时窗口按钮失效；弹窗未居中 | 弹窗与窗口按钮放入同一模态范围，[记录](../.agents/notes/implemented/architecture/2026-11-16-desktop-confirmation.md) |
| 启动加载中刷新会报“应用连接失败” | 修复并加 E2E |
| 筛选只有十来个分类；冷门组合返回残缺页导致列表提前结束 | 738 项实测词表；残缺页识别、重读、拆小页，[记录](../.agents/notes/implemented/architecture/2026-11-16-filter-vocabulary.md) |
| 首页“最新电影”整栏只有片名没有海报，主推区少两部电影 | 豆瓣部分合集把海报放在 `cover.url` 而不是 `pic`，归一化漏读；补上并加单测与真实窗口里的海报解码断言 |
| 打开详情后动画片变成剧集 | 豆瓣详情类型只给三项，改为与副标题取并集 |
| 分年连载（《凡人修仙传 年番4》等）找不到片源或集数不对 | 集数区间映射、基准线路选择、年份差一年与别名的弱匹配，[记录](../.agents/notes/implemented/architecture/2026-11-16-source-identity.md) |
| 累计记录里夹着“第240集上/下”等条目，整条线路作废，分年条目只剩一个源 | 取区间时跳过附加项 |
| 单个源一次不答复，被缓存成“未找到可用片源” | 追问失败的源；未答复时提示重试且不缓存，[记录](../.agents/notes/implemented/architecture/2026-11-16-source-verdict.md) |
| 媒体代理只放行 80/443，金鹰等源的分片被拒 | 与浏览器一致的端口策略，[记录](../.agents/notes/implemented/architecture/2026-11-16-media-ports.md) |
| 片源迟迟不起播时一直转圈 | 35 秒内自动换源恢复，有 E2E |
| 去广告规则依赖域名名单与到期日、跳过加密清单 | 规则 v2，[记录](../.agents/notes/implemented/architecture/2026-11-16-ad-evidence.md) |
| 安装包重复打入 node_modules，Panda.exe 没有图标与版本信息 | asar 79.7 MB → 13.9 MB，保留版本信息，[记录](../.agents/notes/implemented/architecture/2026-11-16-packaging.md) |
| 完全退出后再打开，首页要等几秒 | 先显示上次的首页与落盘的海报；握手卡住的连接 1.5 秒换一条；DNS 双路查询。24 次全新启动页首中位 0.7 秒、最慢 1.0 秒，[记录](../.agents/notes/implemented/architecture/2026-11-17-startup.md) |
| 选源按固定排名，慢源拖住起播，清晰度标签照抄清单声明 | 按首片实际画面与当前网速选源，[记录](../.agents/notes/implemented/architecture/2026-11-17-source-contest.md) |
| 片尾标“第30集已完结”的线路整条作废，完结剧少了几个源 | 集号解析接受“已完结 / 大结局” |
| 分片在 1024 以下端口的源（红牛 65 端口）被拒 | 端口规则改为与浏览器完全一致的禁用名单 |
| 另一部作品搜索时的一次超时，让之后没有片源的作品都提示“暂时无法连接” | 只看本次搜索里没答复的源；解析到非公开地址的源记为此网络不可达 |
| 一个目录拖满 9 秒，所有作品的起播都跟着等 | 找到作品后不再等最慢的目录，迟到的答复补进线路列表 |
| 详情页把演职员全部列出（《三体》68 人），没有照片，不能按人找作品 | 改用豆瓣的主要演职员名单（《三体》8 人，实测 45 部作品每部 4–8 人），带照片；点人进入“全部作品”页，[记录](../.agents/notes/implemented/architecture/2026-11-17-people.md) |

## 已知限制

- 安装包没有代码签名，首次运行会出现 SmartScreen 提示；没有发布服务，应用内不能自动更新。
- 豆瓣、百度榜单与各片源都没有可用性承诺。接口变更或限流时界面显示错误与重试，不会显示假数据。
- 片源没有收录的作品无法播放（上面未通过的条目），桌面显示“未找到可用片源”，TV 在详情页显示“该影片没有片源，请稍后再试”；有目录没答复时显示网络失败或超时并允许重试。360zy 在国内网络解析不到，等于少一个源。
- 没有集数区间别名的连载条目只能按标题匹配，累计记录会把整部连载的集数都列在该条目下（如《吞噬星空 第1季》列出 249 集）。
- 时长指纹只认截取过的广告；源方更换广告后会漏删（不会误删），需要重跑 `npm run audit:ads` 补指纹。
- 冷门筛选组合首次打开可能等待十几秒。
- 主要演职员名单读不到时，详情页只有姓名，没有照片和链接；没有照片的影人显示姓名首字。影人的作品列表是豆瓣收录的全部影视条目（含未上映的），首次打开一个人实测要等 1.5–4.4 秒。
- 清晰度切换、跳过片头只在片源提供多档清晰度、片头标记时出现；实测的片源都不提供片头标记。H.265 或 fMP4 的片源读不出画面大小，不显示清晰度。
- 未验证：高 DPI 多显示器下的窗口位置还原、数小时连续播放；TCL L55P2-UD（Android 5.1）实体电视真机（开发机无实体电视连接，运行时 E2E 在 MuMu Android 15 的 `960×540dp` 标准电视视口下完成，API 22 兼容性由 `minSdk = 22`、`lintRelease` 的 `NewApi` 致命检查、v1+v2 签名与内置根证书静态保障）。

## 验证证据

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| 类型检查 | 本次无错误 | [tv-interaction-checks.txt](evidence/tv-interaction-checks.txt) |
| 离线单测 | 15 个文件 232 项通过（2026-11-18 18:06） | [tv-interaction-checks.txt](evidence/tv-interaction-checks.txt)、[tests/](../tests/) |
| 桌面 E2E（开发构建） | 本次 18/19 通过（2026-11-18 17:50）；强制量子单源的广告播放起播超时，18:04 单独重跑仍失败。附加诊断也观察到目录或媒体请求超时；旧打包版本先出现两轮连接重置，后恢复播放，不能把一次网络对照当作稳定可用性结论。此前 19/19 全通过记录保留在 final-verification.txt | [tv-interaction-checks.txt](evidence/tv-interaction-checks.txt)、[量子源诊断](evidence/runtime/source-diagnostics/) |
| 原型对照 | 成对截图；非播放场景像素差异 0–0.17%；播放场景的差异来自视频画面本身（原型放的是演示片段）；40 个被测控件盒子与原型最大相差 0.97 px（断言上限 1 px） | [evidence/visual](evidence/visual/overlay-report.json)、[界面审阅](ui-audit.md) |
| 筛选词表 | 738 项全部有内容 | [filter-vocabulary.json](evidence/filter-vocabulary.json) |
| 演职员与头像取景 | 45 部作品主要演职员 45/45 答复（每部 4–8 人，中位 52 ms），3 位影人全部作品无重不漏；1123 张头像顶端对齐 93.0% 头部露出九成以上（居中为 20.2%） | [people-audit.json](evidence/people-audit.json)、[portrait-framing.json](evidence/portrait-framing.json) |
| 片源覆盖 / 国内可用性 / 起播 | 本次境外开发机起播探针 23/24，中位总耗时 1.984 秒（2026-11-18 17:50）；读取真实首片及中间分片。覆盖数据见新导出结果；国内测量仍以 cn-sources.md 为准 | [tv-source-coverage-2026-11-18.json](evidence/tv-source-coverage-2026-11-18.json)、[tv-interaction-checks.txt](evidence/tv-interaction-checks.txt)、[cn-sources.md](evidence/cn-sources.md) |
| 去广告线上审计 | 见上表 | [ad-audit.json](evidence/ad-audit.json)、截帧 `evidence/ad-frame-v2-*.jpg` |
| 原型未改动 | 206 个文件 SHA256 一致；契约检查 405 项通过 | `npm run verify:design`、`node design/tools/test-contract.mjs` |
| 安装包（桌面） | 当前 [Panda-1.0.1-Setup.exe](../release/Panda-1.0.1-Setup.exe) 的大小和哈希见上面的发布包记录；打包目录全量 E2E 16/19 通过，其中真实电影 / 剧集 / 动画播放通过，三个强制单源广告后远跳续播用例未通过。asar 检查 268 项，通过。当前安装程序没有在这台电脑上执行；旧安装 1.0.0 未升级。此前 7 项打包 E2E 与旧版安装 / 卸载循环保留在旧证据中 | [playback-stability-checks.txt](evidence/playback-stability-checks.txt)、[install.txt](evidence/install.txt) |
| Android TV 安装包 | [Panda-TV-1.0.3.apk](../release/Panda-TV-1.0.3.apk) 1,068,444 字节、SHA-256 `6112B93C49BA76EC9C7C22E2935564F403DEA8F5404DC3351D56F797542EDEDB`；versionCode 4、minSdk 22、v1/v2 签名通过 | [playback-stability-checks.txt](evidence/playback-stability-checks.txt) |
| TV 遥控器列表与搜索 | 1.0.3 重跑完整导航全部通过，user/library 状态恢复；搜索 3 项通过，user 状态恢复。第一次导航的一项偶发焦点错误未复现 | [导航](evidence/runtime/tv-navigation/playback-stability-1.0.3-repeat/report.json)、[搜索](evidence/runtime/tv-navigation/playback-stability-1.0.3/report.json) |
| TV 播放器与查源 | 1.0.3 播放按钮焦点、连续切至第 3 集、历史记录和无源重试通过；user 状态、防火墙规则恢复 | [播放](evidence/runtime/tv-playback/playback-stability-1.0.3/report.json) |
| TV 动画与滚动 | 1.0.3 重复 4 组首页与展开筛选网格方向键、连续连按；0 卡顿帧、p95 5 ms。Android 15 模拟器结果不替代 TCL Android 5.1 真机表现 | [motion](evidence/runtime/tv-motion/playback-stability-1.0.3/report.json) |
