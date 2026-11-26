# Android TV 前端交互与排版审查

本文保留当时版本的审查结果。2026-11-27 的布局、播放与设备验证见[双端质量复核](cross-platform-quality-2026-11-27.md)。

日期：2026-11-21，UTC+8。本文只评估 `tv/` 的原生 Android 客户端；不是 Electron 的 TV CSS 分支。Windows 结论见[独立报告](frontend-audit-windows.md)，旧材料的可信度见[证据审阅](ui-evidence-review.md)。

## 2026-11-22 TV 1.0.14 复验

本轮在 TV 原生端完成以下改动：

- 新增 `PlaybackBufferPolicy`：`lowRamDevice`、总内存 ≤2 GB、`memoryClass` ≤192 MB 或最大堆 ≤192 MB 时使用 16 MiB / 10–30 秒缓冲，其余 32 MiB / 12–48 秒；播放器启动日志记录实际选择。
- 详情页选集接口失败不再静默隐藏，显示错误行与“重试”；重试前把焦点放回播放按钮，成功后恢复选集。
- 首页榜单、详情、播放器关键间距归一到 4/8/12/16/20 网格；不改变 960×540 基准、4.8% 安全区和唯一焦点环。
- 与桌面同步 `manifestVariants`：单个畸形/非 HTTP 变体跳过；`BANDWIDTH` 解析修正；重导黄金向量并更新 `GoldenParityTest`。

复验：`testDebugUnitTest` 53 项、`lintRelease`、`assembleRelease` 通过（离线缓存构建 1m25s）；最终 APK versionCode 15 / versionName 1.0.14 / minSdk 22，v1/v2 签名通过。`adb devices` 为空，未做 MuMu 或 TCL 真机导航/播放回归；本轮的 TV 结论只覆盖编译、单测、lint 与 APK 身份，不声称真机通过。

## 客户端与证据边界

- 实际设备：MuMu 实例 1，Android 15，横屏 1920×1080，物理 density 280；另做 1280×720@160 与 3840×2160@480 覆盖，并恢复原显示设置。不是实体低端电视或高刷面板。
- 审查前 APK：`release/Panda-TV-1.0.12.apk`，SHA-256 `8AD82282BDDA56C1203F06685734FEBD2874E2C57128E6D646EE35C1C4D8E974`。
- 最终测试候选为 `.tmp/frontend-audit/Panda-TV-audit-r12.apk`，1,820,809 字节，SHA-256 `7C00233AFF37F5E964315CF66CDEB90D589FDA502C230C383C7E841B606ABEED`。versionName 1.0.12，versionCode 13，minSdk 22，Media3 1.8.1。
- 18:09 完成 `testDebugUnitTest lintRelease assembleRelease`、48 项单测及 APK v1/v2 签名校验。18:14 校对 MuMu 已安装 APK 摘要及安装前后用户状态。测试代码截至 R12；原包与各中间候选均按独立摘要记录。
- 播放、搜索、目录与图片使用真实链路。故障回放只临时阻断 Panda UID 的网络；不注入虚构电影或播放地址。完整用户状态、源覆盖、IPv4/IPv6 规则和显示设置均有前后核对。

原始输出与命令入口见[证据索引](evidence/runtime/frontend-audit/README.md)。严重度含义：阻断＝核心路径完全不可用；严重＝丢焦点、错误层级、关键控件被遮挡或错误状态不可恢复；一般＝可继续操作但违反预期；优化＝性能、观感或一致性打磨。

## 已确认的问题与实现

| 编号 / 严重度 | 复现、影响及违反的约定 | 代码与改动 | 实测依据 |
| --- | --- | --- | --- |
| TV-01 严重 | 原包首页导航上沿约 34px，播放器选集焦点右沿 1864px。关键控件落在 overscan 区。 | 统一安全留白，播放器侧栏内容内缩。基础留白为 5.3%，给放大焦点留出余量。[Theme.kt:84](../tv/app/src/main/java/app/panda/tv/ui/Theme.kt#L84)、[PlayerScreen.kt:1224](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L1224) | 原包 surface/panel 回放失败。R4 按严格的 5% 再查，设置右沿 1828px、频道卡片左沿 87px 仍失败。最终包三种尺寸各 8 项通过，采用相同阈值和 1px 取整容差。 |
| TV-02 严重 | 电影选“最新”→剧集→电影，原包排序重置。详情返回或根页替换时，Android 的自动焦点可能替换原卡片，违反返回归焦约定。 | 根页保留，记住卡片 ID 和位置，显式归还焦点。根插入时暂停记录系统自动选中的第一个按钮。[MainActivity.kt:266](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L266)、[Screen.kt:73](../tv/app/src/main/java/app/panda/tv/ui/Screen.kt#L73) | 原包 `channel_memory` 失败。最终包的相邻根页和详情返回在三个尺寸通过。 |
| TV-03 一般 | 电影“最新”→剧集→动漫→纪录片→电影。非活动视图被逐出后，排序、焦点和滚动应能恢复。 | 最多保留两个非活动视图。被逐出的频道保留查询、已取元数据、游标、布局状态和焦点索引，释放原视图与图片。[ChannelPageState.kt](../tv/app/src/main/java/app/panda/tv/ui/ChannelPageState.kt)、[MainActivity.kt:279](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L279) | R5 排序两次失败。最终包在三个尺寸通过真实 D-pad 离开控件和辅助点按的深处留位检查。辅助路径逐次核对实际选中的频道。旧失败的错误归因见证据审阅。 |
| TV-04 严重 | 搜索→进入屏内键盘→输入→Back，原包直接离开搜索。用户无法逐层退出输入模式。 | 键盘 Back 先回输入框，再 Back 回原页面与搜索触发器。编辑已有结果时保留查询和结果。[SearchScreen.kt:144](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L144) | 原包 `keypad_back` 失败。候选 surface、清空与两轮首字母和重新编辑回放通过。 |
| TV-05 一般 | 标题联想刷新/清空时发现页重建；普通 `ScrollView` 只保证矩形勉强可见，焦点可能贴边。详情/设置对上部按钮一律滚回顶也破坏就近滚动。 | [SearchScreen.kt](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt)、[Theme.kt:502](../tv/app/src/main/java/app/panda/tv/ui/Theme.kt#L502)、[DetailScreen.kt](../tv/app/src/main/java/app/panda/tv/ui/DetailScreen.kt)、[SettingsScreen.kt](../tv/app/src/main/java/app/panda/tv/ui/SettingsScreen.kt)：保留键盘区域、为聚焦矩形增加 12u 余量，移除“任一上部按钮强制回顶”。 | R5 搜索清空三组、编辑/Back 两轮、详情/设置与各网格回顶检查通过。滚动余量的实现也逐项核对源码；不把一张截图推广为所有滚动组合均已遍历。 |
| TV-06 严重 | 播放查源时原包只显示“正在查找片源”，没有可聚焦取消按钮。模态遮罩不能让遥控器焦点留在被遮的背景上。 | [MainActivity.kt](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt)：查源遮罩增加取消、阻断背景子焦点、Back/取消中止请求并归还原触发元素。 | 用发布原 APK 重放同一 admission 用例，5 秒内找不到取消而失败；R5 `admission-cancel` 通过，用户状态和防火墙恢复。 |
| TV-07 严重 | 真实断网搜索“三体”，连续两次等了 75 秒仍只有加载态，没有错误和重试。单独给底层阻塞 IO 子任务包 timeout 仍会等其退出。 | [SearchRequest.kt](../tv/app/src/main/java/app/panda/tv/ui/SearchRequest.kt)、[SearchScreen.kt](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt)：页面 await 具有 25 秒期限，请求仍属于现有页面生命周期 scope；过期/取消代次不能更新 UI。 | R3 两次真实阻断失败；R5 两次出现“连接超时，请重试”，解除阻断后约 1 秒恢复结果。新增三项单测覆盖取消不敏感后台、旧查询取消与合法空结果。 |
| TV-08 一般 | 搜索重试虽恢复真实结果，焦点却跳到“首页”，需要重新走导航。旧脚本只断言有搜索结果，漏掉这次跳焦。 | 删除重试、键盘及联想等临时节点前，先把焦点交给持久输入框。结果在搜索页持有焦点时接管。[SearchScreen.kt:290](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L290) | 加强同一真实断网回放后，R5 两次记录焦点为“首页”。最终包两轮均约 25.1 秒出现超时，遥控可达“重试”，恢复结果后焦点落在《三体》卡片。 |
| TV-09 严重 | 主搜索失败，回退接口返回空数组，原逻辑可能显示假“没有找到”；首字母查询也可能被一个 fulfilled 空结果吞掉错误，立即重试还继续绕开主接口。 | [DoubanDataSource.kt:736](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt#L736)：保留主错误；无已验证匹配且回退未恢复时传播可重试错误并取消避让；保留合法空结果和已验证部分结果，与桌面规则对齐。 | 双端同一失败场景先红后绿；TV TitleSearchTest 七项、页面超时三项及完整 48 项离线单测通过。没有以虚构匹配填补失败。 |
| TV-10 一般 / 第二轮打磨 | 快速五次 Down 再五次 Up，第一轮修复仍会错位，两个重复场景均失败。按当前渲染位置逐键计算会吞掉滚动期间的输入。 | 保留逻辑目标和列记忆，每帧只提交最新滚动目标。离开网格或 detach 时清理待提交任务。[Theme.kt:354](../tv/app/src/main/java/app/panda/tv/ui/Theme.kt#L354) | 修改前两次失败。第二轮普通移动、快速连按与 1250ms 长按均通过。原始 gfxinfo 数据见运行证据。 |
| TV-11 优化 / 默认行为 | 播放器浮层关闭后需要归焦。连续 seek 需要预览和合并，避免每个重复键都让解码器重缓冲。确认长按需要防止二次激活。 | 选集、线路、清晰度、倍速复用右栏、遮罩与焦点陷阱。关闭时归还触发器。加入 seek 时间预览和合并，以及媒体键与隐藏态确认去重。[PlayerScreen.kt:1224](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L1224)、[PlayerScreen.kt:1055](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L1055)、[PlayerScreen.kt:310](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L310) | 审查原包存在播放器选集越过安全区。候选实测选集浮层循环导航、Back 归焦、暂停/播放、自动隐藏、方向键呼出及 1250ms 确认。 |
| TV-12 一般 | 我的→历史→依次进入电影、剧集、动漫→我的。缓存逐出后，历史回到收藏，原控制位置丢失。 | 在两个非活动视图的上限内优先留下首页和我的，将频道的状态存入轻量快照。[MainActivity.kt:279](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L279) | R9 两次重置为收藏。最终包三种尺寸均恢复历史选中状态，按 Down 回到历史页签。 |
| TV-13 一般 | 详情的选集已经加载时，从主播放按钮进入播放器，Back 回详情可能落到刚附加的集数网格。 | 暂停系统自动焦点对记忆的更新，重新附加详情后恢复实际离开的按钮。[MainActivity.kt:401](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L401)、[DetailScreen.kt:59](../tv/app/src/main/java/app/panda/tv/ui/DetailScreen.kt#L59) | 单项回放先等真实选集加载，再从确认聚焦的主按钮起播，实际 Back 后核对“继续播放”。R10 独立两轮通过，最终包的断网恢复路径也验证同一归焦。 |
| TV-14 严重 | 播放《三体》→阻断 App 网络→下一集。片源准备可超过 45 秒，遥控器等不到可操作的错误层。 | 给单次播放解析设 40 秒界面等待期限，超时进入可聚焦的重试/返回状态。后台请求仍归播放器生命周期，过期或旧集的请求不能装入新画面。[PlayerScreen.kt:781](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L781)、[SearchRequest.kt:12](../tv/app/src/main/java/app/panda/tv/ui/SearchRequest.kt#L12) | 同一脚本 R10 两轮等到 45 秒仍在转圈。R11 独立两轮约 40.1/40.2 秒出现重试，解除阻断后约 5.6/5.3 秒播到目标集，Back 回到详情续播键。 |
| TV-15 严重 | 电影频道或《三体》演职员→于和伟→全部作品，首屏加载后断网并下移到列表末尾。R11 收到续页超时，只写日志。旧内容还在，遥控器无法知道失败或重试。 | 网格下方留固定状态区。失败保留已加载卡片、游标和焦点，暂停自动续页。末行 Down 到重试，Up 或确认先归还原卡片。首屏用不接管焦点的六列静态骨架预留尺寸。[ChannelScreen.kt:377](../tv/app/src/main/java/app/panda/tv/ui/ChannelScreen.kt#L377) · [PersonScreen.kt:181](../tv/app/src/main/java/app/panda/tv/ui/PersonScreen.kt#L181) · [PosterPage.kt:16](../tv/app/src/main/java/app/panda/tv/ui/PosterPage.kt#L16) | R11 两页均有真实超时日志，等待 32 秒仍无错误提示。R12 实机逐行遍历 30 个片名；两页都验证末行 Down 到重试、重试时末行可见、Up 和确认回到同一张卡片及同一纵坐标，恢复联网后下一次 Down 到新片名。首屏骨架检查六个 poster 的实像素与 gutter 不同。 |

没有发现可单独归为“阻断”且已排除第三方媒体/网络失败的前端缺陷；不为了填满严重级别编造问题。

## 逐页、组件与行业约定

| 页面 / 浮层 | 实际检查与结论 | 边界 |
| --- | --- | --- |
| 全局导航、首页主推 | 原包与候选实际渲染；七个根入口和搜索/设置可通过 D-pad 到达；首页播放/详情、横向栏目、榜单 More、返回与重复操作。选中标记不是焦点环。 | 首页/我的的非活动视图缓存有数量上限；跨多根的频道恢复另以 TV-03 验证，不能把相邻根切换当全部组合。 |
| 五频道、筛选抽屉、海报墙 | R12 三尺寸各 8 项 surface 检查；每频道普通/快速左右、D-pad 向上回顶、筛选展开后回顶。另测频道续页失败与恢复。 | Live 查询返回的目录和文案记录在各回放中；卡片保留绘制不会证明上游每张海报都成功。 |
| 搜索、屏内键盘、联想、发现、结果与分类 | R12 清空三组、两轮首字母与重新编辑、键盘 Back、末行列保持，基于真实刘德华多行结果测网格滚动，并以真实“三体”查询测详情与影人作品；两轮真实网络故障及 Retry 归焦。 | “三体”实时搜索这次仅有一行，旧回顶测试不能据它证明滚动。新测试另用实际多行结果验证，再换回“三体”。结果 Retry 归焦与错误时序均读实机焦点。 |
| 详情、演职员、影人作品、相关推荐、详情选集 | 真实详情加载/错误重试、收藏、演职员进入与 Back、作品网格回顶、详情返回原卡片；固定卡片文本行高，避免字体回退导致列高不同。 | 播放可用性与相关推荐是异步真实数据，不伪造时长、集数或质量。 |
| 收藏、历史 | 播种回放保留并恢复完整原用户状态；收藏/历史网格、详情返回卡片、清空确认、空态、进度显示。 | 种子条目属于设备测试，不是首页内置假数据；空态源码核验与有数据的真实导航分开。 |
| 设置、清空确认 | 遥控器逐行、滚动跟随；确认初焦点为“取消”，多方向循环不逃到背景，Back 返回原触发器。 | 更新服务未配置不显示虚构更新成功。 |
| 查源遮罩、Toast、加载与错误 | 查源模态锁住背景焦点，可主动取消。R12 两次实测断网等待约 25.7/25.8 秒后，错误消息出现，遮罩关闭并归还首页播放焦点。Toast 不抢焦点，替换前清计时器，2400ms 后消失。 | 频道与影人作品使用六列静态首屏骨架和独立的续页状态区。图片失败时卡片保留尺寸和标题。 |
| 播放器顶/底控件、进度、OSD | R11 已安装候选播放回放实际通过媒体键、普通方向键、1250ms 长按确认、约 3.1s 自动隐藏、seek 预览、倍速、六轮同 PID 起播/Back。R12 保持相同播放器代码；起播、详情和查源失败反馈抽样重放。 | R12 全批次被当前可用片源及 MuMu 自动化服务异常打断；当次播放器主交互未形成独立完整复证。不能把 R11 的通过替换成 R12 的播放保证，也不能把 R12 上游失败当成播放器 UI 缺陷。 |
| 选集、倍速、线路、清晰度侧栏 | R11 实际验证选集返回焦点、侧栏导航、隐藏/呼出、seek、倍速和一条真实换线。R12 在《三体》首次起播即出现真实重试画面；独立选集面板回放也停在 Retry，未打开面板。 | R12 有 3 个播放器子场景通过，2 个不可用，10 个场景没越过起播/测试器前置条件；报告保留每项阶段。不能声称 R12 的面板/轨道完成实测。清晰度与软字幕未获真实多轨样本。 |
| 字幕、音量、全屏 | TV 全屏为原生 Activity/SurfaceView，音量交给系统媒体流；源码未发现独立字幕选择界面。 | 未获得真实多清晰度或字幕轨样本，未对不存在的面板声称实测；不是把桌面的音量滑条/字幕层拿来代替 TV 验证。 |

## 大屏交互约定逐条核查

评估依据是 Android 官方关于方向键和返回、多焦点提示、大屏留白以及媒体键的建议。项目另对持续输入、返回留位和错误恢复建立了可重放断言。[导航](https://developer.android.com/training/tv/get-started/navigation) · [焦点](https://developer.android.com/design/ui/tv/guides/styles/focus-system) · [大屏布局与安全区](https://developer.android.com/develop/adaptive-apps/guides/tv/build-adaptive-apps-for-tv) · [播放控制](https://developer.android.com/training/tv/playback/controls)

| 约定 | 当前实现与检查 |
| --- | --- |
| 单一可辨焦点 | 使用亮描边、轻微缩放和前置层级。surface、确认框与播放器检查实际聚焦节点。背后的选中页签仍用较弱标记。全屏隐藏控件时，输入先由播放器接管。 |
| 方向键 | 横排在边界保持在当前组，海报网格按行列移动并保留目标列，通过 23 个导航回放和两轮首页榜单 More 回放。已检查的关键目标都通过方向键到达和激活。 |
| Back 与层级 | 查源、确认框或侧栏 → 播放器控制层或屏内键盘 → 上一级页面 → 首页或退出。确认框测试还覆盖长按 Back。 |
| 焦点及滚动记忆 | 详情返回比对原卡片及其纵向位置。根页分别比对真实离开时的控件、页签和排序，另有辅助深处留位探针。 |
| 滚动跟随 | Leanback 对齐聚焦行。详情、搜索、设置的滚动容器为聚焦矩形留 12 个逻辑单位的余量。导航断言发现列表回到第一行后才能继续移到页头。 |
| 安全区 | 在 720p、1080p、4K 测试可见窗、导航控制和聚焦项的 5% 边界，允许 1px 取整差。截图复看实际描边和面板内容。 |
| 远距离读屏 | 960×540 逻辑单位适配三种分辨率，1080p 常用正文和按钮约 26–35px。海报预留固定文字行高，长标题单行省略，详情保留原文。模拟器测量只覆盖布局与对比。 |
| 快速和持续输入 | 短按、快速五次往返和 1250ms 长按由脚本按实际遥控器键码发送。焦点短动效可中断，长按确认只触发一次。 |
| 模态、Toast 与 OSD | 确认、查源、选集均锁住背景焦点。Back 恢复触发器。Toast/OSD 有时限，seek 预览在画面中上区。 |
| 播放控制 | 隐藏态确认切换播放，左右步进，长按 seek 加速，上下键呼出，媒体键独立。真实网络故障验证可重试。清晰度只使用真实轨道，软字幕未获真实轨道样本。 |
| 状态 | 查源、搜索、播放器提供加载和错误反馈。搜索区分成功空响应与超时。频道和影人作品首屏预留海报位置，续页失败保留当前卡片并开放重试。 |
| 转场与按需渲染 | 首页和频道通过回收式列表按需绑定，频道保留有限视图。入场以 alpha 和轻量位移提示层级，返回直接恢复原页和位置。使用 gfxinfo 观测真实输入窗口，首次加载与媒体解码另计。 |

## 性能与验证限制

- 第一轮后再针对连续输入做了第二轮，而不是只缩短动画时长：逻辑输入逐项保留，渲染每帧合并，95ms 焦点动效与 120ms 页面 reveal 可被新输入取消；detach 清理动画、图片任务与待提交位置。
- R12 motion 四段共 881 个 gfxinfo UI 帧，jank 0，p95 5ms；包含首页和展开频道内按键窗口，第二轮已记录。模拟器 UI 帧统计不覆盖视频合成、实体低端 TV、高刷撕裂，故不写成端到端稳定 60fps。
- R5 自动隐藏实际观测约 3127ms；六次同 PID 返回详情均恢复“继续播放 第1集”，View 数均为 383，Activity/ViewRoot 均为 1。Java/native heap PSS 是有限窗口观测，不等于长期零泄漏。
- R5 seek 六步预览后约 4345ms 恢复推进；2×样本墙钟有效速率约 1.81×、可观察活动片段约 2.08×，UI 秒级时间读数有限；该轮没有拿到 renderer frame-counter 回调。不能写成“解码稳定 60fps”。
- 没有实体低端 TV、Android 5.1 解码器、高刷面板/撕裂证据；未做 CPU 亲和/低资源模拟。目标是优化帧预算，以上环境边界不是性能达标承诺。

## 最终验证范围与边界

- R12 APK 已安装并以字节 SHA 对上；三个安全区/布局批次分别在 1920×1080、1280×720、3840×2160 下各 8 项通过。导航 23 项、More 6 项、搜索错误/焦点两轮、标题搜索 4 项、分页 3 组（初始骨架、频道、影人作品）、查源 deadline 2 次全部通过。报告和失败输出保留在[证据索引](evidence/runtime/frontend-audit/README.md)。
- 独立导航完整重放通过，并核对测试用户状态、IPv4/IPv6 防火墙规则和显示尺寸/密度前后相同。一次早期 navigation 调用及播放批次曾被 MuMu 的 `uiautomator dump` 自身异常中止；原始崩溃日志与重试后报告都保留。这里不把原失败隐去，也不按它推断 TV 应用崩溃。
- R12 播放批次报告为 3 passed / 2 unavailable / 10 failures，用户状态和防火墙均恢复。其中 Retry 画面出现但无法取得可解码媒体的场景，与停在 Android 启动器、UiAutomationService 已注册时再次崩溃的场景分别留存。独立选集回放仍在真正开面板前遇到 Retry；这类样本未验证面板行为。同一播放器实现的 R11 完整批次为 10 passed / 1 unavailable / 4 failed，其中两项详情返回用固定集号而未执行、两项断网错误恢复未成功；独立 R11 双轮截止时间回放分别在约 40.1/40.2s 显示 Retry，联网后约 5.6/5.3s 推进并归还详情播放按钮。详见每份报告自己的 APK hash，不跨包合并成“全部播放通过”。
- R12“missing source”场景仅观察到 retryable，不是已证实无片源；字幕、独立音量条、真实多清晰度切换和实体低端/高刷电视均未得到样本。MuMu 上 881 UI 帧 p95 5ms 是有限帧窗口，不是稳定 60fps 的硬件保证。

## 复跑

```powershell
& 'D:/Program Files/Netease/MuMu/nx_main/mumu-cli.exe' info --vmindex 1
# 使用返回的实际 serial，不按实例推算端口；先显式安装待测 APK。
python -X utf8 scripts/verify-tv-surfaces.py --serial <serial> --apk <apk> --output <新目录>
python -X utf8 scripts/verify-tv-search-errors.py --serial <serial> --apk <apk> --output <新目录> --repeat 2
python -X utf8 scripts/verify-tv-pagination.py --serial <serial> --output <新目录>
python -X utf8 scripts/verify-tv-navigation.py --serial <serial> --label <新标签> --extended --library
python -X utf8 scripts/verify-tv-motion.py --serial <serial> --label <新标签> --repeat 2 --hold
python -X utf8 scripts/verify-tv-playback-transitions.py --serial <serial> --label <新标签> --case all --line-title 流浪地球2 --switch-repeats 2
```

原始失败和旧测试路径保留，重跑写入新目录。辅助顶栏点击只用于保持深处离开位置的状态集成验证，不作遥控器可达性证据。性能/播放器结论只限于报告记录的实际动作与设备条件。
