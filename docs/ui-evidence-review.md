# 前端验证材料、脚本与清理核验

本文保留当时版本的审查结果。2026-11-27 的布局、播放与设备验证见[双端质量复核](cross-platform-quality-2026-11-27.md)。

日期：2026-11-21。目的不是寻找能给出绿色输出的命令，而是确认它测到了哪个产品、什么状态以及是否真的执行了断言。当前[TV](frontend-audit-tv.md)与[Windows](frontend-audit-windows.md)分别给结论。

## 旧原型为何误导

旧 fixture helper 会同时开生产 renderer 与 `design/preview`；两者读同一组模拟目录，再做几何/截图比较。对照旧原型“像不像”不能证明当前包的数据、焦点、可点击性、播放或安装。原型并不随生产源码更新，因此用户每次看到它会误以为 E2E 验证的就是旧前端。

本轮移除第二 Electron 窗口、原型服务路由与两个成对对照用例。`design/` 只保留冻结资产/契约参考，不再作为应用验收页面；没有再启动 `design/preview`，也没有创建一个需要长期同步的新原型。生产仍可复用设计 CSS、文案、图标、字体与契约，但不能导入 mock/art/preview。

fixture 保留为**隐藏的当前生产 renderer + 测试 IPC/数据/视频**。真实构建与确切包另跑 live；记录唯一窗口、生产路径、URL、ASAR 哈希及 renderer chunk。HTML 报告已实际加载动态 DOM：fixture、packaged-live 与修正资源回放均有可见模式标题，页面没有运行时错误。没有以静态 HTML 默认标题反推动态标题失效。

## 核验结论与纠正

| 材料 / 检查 | 不可靠之处 | 当前处理 / 可靠替代 |
| --- | --- | --- |
| [ui-audit.md](ui-audit.md) | 2026-11-16 静态原型审阅、参考图和对照截图，不是现版 Windows/TV UI。 | 明确历史参考标签；分端在真实编译 renderer、真实包和原生 APK 上检查。不能用 design contract 的 405 项代替应用交互。 |
| [implementation-plan.md](implementation-plan.md) | “尚无生产源码”等是立项当时状态；旧原型对照验证计划已失效。 | 标为历史选型/里程碑，改正当前 E2E 入口与证据边界；保留有价值的选型理由，不假装全篇是现版说明。 |
| [douban-audit.md](douban-audit.md) / [playback-audit.md](playback-audit.md) | 旧 HTTP/清单/少量分片采样不能证明当前可用率或实际解码。接口与源也会变。 | 加历史标签；保留请求时刻、HTTP 状态和采样身份。当前结论用真实查询、video/Exo 播放状态、截图、进度和解码样本，不混称国内网络或所有源稳定。 |
| [delivery-report.md](delivery-report.md)、[final-verification.txt](evidence/final-verification.txt) | 跨版本的计数、包名、模拟器和安装证据容易被读成当前全绿；同版本 APK 可有不同字节。 | 历史验收分块保留；当前报告链接置顶，包 hash 与运行时刻单独标注。旧失败不删、不覆盖、不补造成功数字。 |
| 历史 `docs/evidence/visual/*-production.png` | 部分实际上来自 fixture，与 prototype 对照；名字会让人误认真实生产数据。 | [visual/README.md](evidence/visual/README.md) 明确分类；新 fixture 图片名带 fixture，目录/报告也按模式分离。原历史证据不随意重命名覆盖。 |
| 旧 `docs/evidence/e2e-report/index.html` | 574,626 字节的旧捆绑报告会再次展示失效原型/fixture，易误认最新结果。 | 删除旧 HTML，保留唯一失败上下文和[历史 README](evidence/e2e-report/README.md)。新报告默认 `.tmp/`、`open: never`，审核后只提升必要证据。 |
| `tv/gradlew.bat` | 故意不存在的 task 实际 `BUILD FAILED`，旧 wrapper 返回 0。下游即使诚实判断 exit code 也会假绿。 | 保存同一命令修改前 exit 0 与修改后 exit 1；在 `endlocal` 前捕获 ERRORLEVEL，再退出传播。实际 unit/lint/release 另行执行，不把退出码修复当构建成功。 |
| 旧 `scripts/verify-tv-mumu.py` | 导入副作用、固定设备/启动策略、破坏用户状态的假设，不能作为无副作用通用 helper。 | 删除旧 runner，提取 [tv_runtime_helpers.py](../scripts/tv_runtime_helpers.py)；serial 必填，不隐式安装，不 `pm clear`，回放完整备份恢复用户状态。 |
| 只检查一个焦点或可见几何 | 一个隐藏背景焦点也可能“只有一个”；控件有矩形并不代表能命中，4.5% 也不是 5% overscan。 | TV 结合真实 focused 节点、文本、可见边界、截图、方向激活与归还。安全区改为 5% + 1px 取整容差，检查放大焦点；Windows 加中心 `elementFromPoint` 命中和原生窗口尺寸。 |
| 搜索看到结果即通过 | R5 真实 Retry 恢复结果却把焦点放在首页，原脚本仍 pass。其 errorMs 还把截图、恢复网络和移动 Retry 的时间算进错误出现耗时。 | 增加结果焦点断言；错误刚出现即记录 `errorObservedMs`，另记 `retryFocusReadyMs`，并限制页面错误出现的观测窗口。两轮真实旧行为先失败再修。 |
| 第一次续页回放读取卡片的第一个可见文本 | 评分、图片失败时的占位文字和真正片名在同一个节点树里。早期 R12 的电影回放判为通过，截图和 XML 却只表明它停在旧卡片《哪吒之魔童闹海》。 | 保留早期结果。更新探针后逐行读取标题控件，第一批共记录 30 个名字。检查末行仍可见、Up 和确认后均回到该卡片，并比较坐标。最后一次 Down 必须聚焦此前没出现的片名。电影和演员作品均以此重跑通过。 |
| 只做相邻根页切换 | 两个非活动视图缓存足以让短路径通过，超过容量仍忘掉频道排序。 | 增加跨三频道驱逐的实测，R5 排序两次失败，R6/R7 排序恢复。卡片/滚动基线的问题另列下一行，不能把它混算成真实驱逐失败。 |
| 本轮最初新增的驱逐卡片测试 | 拍深处卡片后调用 `focus_top_bar`；它用 Up 把列表滚回顶、经过筛选按钮。再次回页时仍要求深处原卡片，是测试自己改变了离开位置。 | 撤回这部分 R6/R7 的焦点失败归因；D-pad 测试现在在真正离开的筛选按钮拍基线。另加明确标注辅助 top-bar tap 的深处状态集成测试，不以 tap 证明遥控器可达；原误判输出保留。 |
| 首个辅助点击驱逐探针 | Android 可触摸模式的可聚焦导航按钮第一次 tap 只取得焦点，不激活。没有逐次检查选中页，所谓“跨三个频道”实际一直留在电影。 | R9 加逐次 selected 核验后直接复现“剧集未激活”；撤回旧 auxiliary 的驱逐失败归因。当前辅助路径先 tap 到真实焦点，再 Confirm 激活并检查实际选中频道。它仍不用于证明纯遥控器可达性。 |
| 播放器探针里的 `1 / 5` / 隐藏控制层 | 首页轮播计数不是时间轴；截图耗时可能让控制层自动隐藏，之前有由此产生的假失败。 | 时间轴严格识别时分秒；用普通 D-pad 呼出并核实焦点后激活，不能靠反复 MEDIA_PLAY“保活”；媒体键本身另做专门回放。 |
| 详情等待固定的第 1、2 集 | 批次内较早的播放已推进到第 3 集，选集横排会随进度对齐。因此确认已加载的检查等了两次 60 秒，既没激活播放，也没测到 Back。 | 保留 R11 原失败。新脚本确认有选集标题和多个实际可聚焦的数字集数，再激活播放并检查返回焦点。断网重试也明确要求目标集推进。 |
| 播放时间读到非零就算起播 | 续播打开时显示的保存进度可以保持不动。连续按 Down 还可能把已经显示的错误层焦点从重试移到返回。 | 采样到预期剧集、非缓冲和暂停按钮后，再要求时间连续推进。错误层已出现就保存现场。断网重试记录触发集、目标集、错误时间、Retry 焦点及恢复阶段。 |
| TV 切线/切集笼统失败 | 在初次起播或前置 seek 补缓冲失败，不能说明已经执行并失败了切线/Next。 | 保存原失败，增加失败阶段、实际焦点/时间轴、当前 PID 的脱敏 logcat。没到目标动作就不下切换交互结论，也不把“播放失败”一律改成 skip。 |
| Windows listener 数量增长 | Playwright 首次输入会安装 13 个全局捕获 listener，原资源脚本误归为应用泄漏。 | 对实际 `DOMDebugger.getEventListeners` 的 scriptId 分组，与保留事件同源才归 harness；应用 listener 集合仍须与基线相同，第三/六轮完整集合仍须稳定，WeakRef/timer/页面错误单独断言。修正后独立重跑通过，原完整批次不改写。 |
| 构建/包校验代替安装 | unpacked 真包不等于 NSIS 已安装；安装检查会原位升级用户既有 Panda，卸载会移除它。 | 不为了 UI 审查升级/卸载用户安装。新候选明确“未安装”；ASAR 清单与真实包 UI 回放分开，不声称 NSIS 安装/卸载已验收。 |

## 已撤回、不能定稿的推断

- 《蜡笔小新》ID 1431683 的 movie/tv 路径 400 假设：两轮真实请求两个路径均 200，没有保留 400 响应体证据。原文 LBXX 返回的不相关英文条目需要过滤，但不支持扩大 `readSubject` 400 回退规则。保留诊断，不改业务读取条件。
- 最初的 R6/R7 驱逐“丢深处卡片”断言：helper 自己把焦点与滚动移到了页头，基线不代表离开状态。只保留其中真实的查询丢失证据，焦点需用修正后的独立回放判断。
- “电影倍速失败”不能套到这次 R3：实际失败断言在 seek 500 秒后不推进，倍速阶段没有执行。旧 12 秒样本也不能代替本轮未执行阶段。
- “release heap dump 已成功”：设备实际以非 debuggable 权限拒绝；只有被清掉的零字节临时文件，没有完整 heap dump 或长期泄漏结论。没有为取证把 release 改成 debuggable。
- “稳定 60fps / 高刷无撕裂 / 低端 TV 达标”：MuMu gfxinfo、Electron rAF 与有限解码样本不具备这样的覆盖范围。报告原始窗口、p95/max、jank 与工具局限，不写硬件保证。
- “网络错误也说明影片没片源”：失败目录只能得到 retryable；confirmed missing 必须来自真实目录的成功空响应，限制目录的测试须标明临时 subset。

## 已执行的清理与保留

删除/移除：`e2e/smoke.cjs`、旧 TV runner、原型第二窗口与成对用例/原型路由、旧捆绑 HTML 报告。清除 `.tmp/` 中 44 个旧 fixture profile、5 个旧 desktop profile与2个中间 patch；清单留档。

保留：206 个冻结 `design/` 文件及 SHA-256 基线、独有的失败前输出与截图、已发布 `release/`、用户安装与完整设备用户资料；不清理用户已有 `.github/`、CI/发布文档和未提交业务文件。构建候选、暂存播放器输出与尚未审核的 probe 在 `.tmp/`，不进入应用 ASAR/APK。

防复发规则已写入 [AGENTS.md](../AGENTS.md)、[证据决策](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/notes/implemented/testing/2026-11-21-runtime-ui-evidence.md) 与 [TV 回放工作流](https://github.com/7788dev/PandaTv/blob/4220d6dff973a55f42508a49a9c0c3d43d3b296a/.agents/skills/tv-runtime-regression/SKILL.md)。使用独立新标签，读取 failures/unavailable 与实际执行的动作，不单凭 exit 0 或一张截图写全绿。

原始材料、包摘要和已执行的场景见[证据索引](evidence/runtime/frontend-audit/README.md)。

## R12 安装后交叉复核

R12 已实际安装到 MuMu 15，安装前后用户状态 SHA-256 相同；设备摘要确认候选字节与 R12 APK 相同。页面安全区与缓存、主页榜单 More、完整方向键导航、键盘编辑、真实搜索错误/恢复、分页错误/恢复、查源超时与两轮 motion 分别有新标签和独立报告，不能将它们误读为一次大批次的单一测试结果。

分页首轮仍是无效检查：对子卡片取“所有非空后代的第一个文本”，读到评分而不是片名。虽错误点亮了“新标题”，查看真实截图/XML 后撤回该结论。严格探针只读取标题控件，另以 30 个实际可见标题集合比对恢复后新焦点；确认重试时末行不滚出视口，Up/Confirm 恢复同一标题及坐标，恢复网络后的 Down 到达新片名。这轮 R12 channel/person 均通过。

播放器批次不是全绿：三项通过、两项 unavailable、十项失败。对能看到真实 Retry 的用例，错误原因是起播预检查失败，该动作未运行；部分后续调用实际仍停在 Android 启动器。`tv-crash-all-r12-final.log` 记录 Android UiAutomationService 重复注册异常，之后的 launcher 症状不能算 Panda 的播放器页面。独立选集面板回放也停在 Retry。保留所有结果，分别记为未覆盖或环境依赖，不以最后一帧倒推产品缺陷。播放器相同实现的 R11 有一组实际成功的独立控件样本，仍只作为 R11 包的证据，不跨摘要提升 R12。

播放进度等待现在要求目标集处于非 buffering 的活动状态，至少两次采样时间单调推进。续播已有的非零旧时钟不能证明新集已开始解码；任意离开播放画面的焦点也不能当作当前页面焦点。详情返回检查按 UI 实际显示的剧集，而不是固定的早期剧集编号。对应的重跑和修正证据都保留在同一索引中。
