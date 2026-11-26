# Windows Electron 前端独立审查

本文保留当时版本的审查结果。2026-11-27 的布局、播放与设备验证见[双端质量复核](cross-platform-quality-2026-11-27.md)。

日期：2026-11-21，UTC+8。本文只评估 Windows 的鼠标/键盘、悬停、窗口与 Electron renderer；不会按 TV 的 overscan、遥控器行列导航或大字号标准给桌面制造问题。TV 见[独立报告](frontend-audit-tv.md)。

## 2026-11-22 排版与播放器复验（1.1.4）

本轮在 `src/renderer/app.css` 覆盖层与生产组件内修复排版，不改 `design/`：

- 1080×640：主推文案区宽度上限 560px，缩略图 64–92px 自适应，短窗口收紧标题/段落/按钮间距；详情页 ≤1200px 改为 168–220px 海报列；播放器底栏收紧控件与时间字号；搜索面板 ≤1240px 收窄到 360px。
- 卡片/榜单/选集/演职员/推荐条/确认框/播放器控件间距统一使用 `--sp-*`；卡片、榜单、演职员截断文字增加原生标题提示；错误态统一 `role="alert"`。
- 页面滚动位置按稳定路由键记录，并在离开页面的渲染阶段取样；返回首页/详情恢复实际位置。新增几何与滚动恢复用例在 `e2e/layout.spec.ts`。
- 播放器 HLS 增加 `capLevelToPlayerSize`、`startFragPrefetch`、请求清晰度上限；看门狗以媒体时间是否真实前进为准，修复 `readyState >= 3` 时漏判解码冻结。

复验：`npm run typecheck`、`npm test`（21 文件 295 项；发布构建时 288 项，发布后补 4 项 HLS/LoadPolicy 静态回归与 3 项布局契约）、`npm run build`、`npm run test:e2e:fixture`（25/25，5.8 分钟）、`npm run verify:design`（206 文件不变）、`node design/tools/test-contract.mjs`（405 项）。最终 `release/win-unpacked/Panda.exe` 的真实剧集 HLS 用例 1/1（29.1 秒，第 1→2→3 集）；`out/` 构建同一用例 1/1（20.7 秒）。未安装 NSIS 包，未据此宣称安装或卸载通过。

## “测试前端”和真正应用是否相同

旧 E2E 确实会另开一个 `design/preview` 原型窗口。原型和测试 renderer 都使用模拟数据，再做布局对照；这很容易被误认为当前 Windows 应用。本轮已移除原型窗口、HTTP 路由与两个成对对照用例，不再启动或维护它。

现在三个模式严格分开：

| 模式 | 加载什么 | 能证明什么 |
| --- | --- | --- |
| `desktop-fixture` | 一个隐藏的 Electron 窗口，加载当前 `out/renderer/index.html`，测试 IPC/目录/视频 | 生产 renderer 的确定性布局、空/错状态与交互回归；不是原型，也不是生产数据或安装证明 |
| `desktop-build-live` | 当前编译主进程/preload/renderer，真实 bridge 与网络 | 源码构建的真实应用行为；不代表 NSIS 已安装 |
| `desktop-packaged-live` | `PANDA_E2E_EXECUTABLE` 指定的真实 Panda.exe，renderer 从它的 app.asar 加载 | 这个确切包的真实数据、交互和播放；仍须说明是 unpacked 候选还是用户安装目录 |

每次 live 启动核对唯一窗口、`app.getAppPath()`、`isPackaged`、renderer URL；包 UI 用例再核对 ASAR SHA-256 与当前 renderer chunk。没有凭版本号推断二进制相同。HTML 报告的动态 DOM 也已在 headless Chrome 实际打开核验，三份报告的标题与可见正文标出上述模式，没有只检查静态 `<title>` 就下结论。

本轮实际测试的 Windows 候选：`.tmp/frontend-audit/windows-r3/win-unpacked/Panda.exe`；ASAR SHA-256 `27C4028F5C6B577C224F2B1DD5B0AAD3252CC98C7EBF0CAEB3772E2795A28CE4`，renderer `index-DhwGucV8.js`。最新源码 build 仍产生同一个 renderer chunk。候选 NSIS SHA-256 `977D29F32A8A86FE80EF68E34A0B81BEF16DDE429C02212D1E2CE109EEEC8EC9`，**未安装**；没有升级或卸载用户现有 Panda。用户现有安装与这一候选的修改版不能混称同一个已安装产品。

补充只读核对：注册表指向 `D:/Programs/Panda/Panda.exe`，已安装 ASAR 与仓库 `release/win-unpacked/resources/app.asar` 都是 13,785,502 字节、SHA-256 `823108D66FCFD4C8E690BB24977401576A992CE91E3794433081B819DFE31302`。REA 独立读取相同摘要，包内 246 个普通文件、26 个目录，未发现完整性矛盾；这是静态包身份，不是重新启动该安装的运行证据。它与 R3 修改候选确实不是同一份字节。因此，“旧原型”“当前源码 fixture”“原发布/已安装包”“本轮修改候选”必须四者分开；版本都写 1.1.2 也不能混用验收结果。用户安装未启动、未升级、未卸载。

## 已确认问题与修复

| 编号 / 严重度 | 复现、影响与原则 | 代码与修复 | 验证 |
| --- | --- | --- | --- |
| WIN-01 严重 | 原构建 1080×640 窗口→Ctrl+K→“三体”联想，设置按钮中心命中 `winctl__btn`，被窗口控制遮挡。是桌面窄窗 flex 冲突，不是 TV 安全区问题。 | [app.css:14](../src/renderer/app.css#L14)：≤1160px 搜索弹性收缩、保留操作按钮空间，取消该尺寸分支的宽度动画。 | 同一 packaged UI 用例修改前失败，记录设置 left 933.875/right 971.875 与实际 hit；R3 真包重放通过，搜索/窗口控件命中检查为空。 |
| WIN-02 一般 | 搜索联想首次 ArrowUp 落到倒数第二项；Escape 主动 blur 输入，无法继续键盘操作；加载/防抖期间旧联想目标可能仍可激活。 | [App.tsx:32](../src/renderer/App.tsx#L32)：首次反向导航选末项，Escape 关闭但不 blur，关闭/新输入重置 active；等待/失败时不暴露旧目标，隐藏面板 inert。 | 新 fixture 交互用例在原代码上失败、修改后通过；R3 真包验证 Escape 保留 combobox 焦点并继续 Enter 搜索。旧代码中的 blur 和旧目标路径另经源码交叉核对，不声称旧测试在首断言失败后还执行了所有断言。 |
| WIN-03 严重 | 选集面板没有完整模态所有权，Tab 可进入后台，播放器快捷键可能在面板操作时 seek，关闭后的焦点不稳定。 | [Player.tsx:572](../src/renderer/Player.tsx#L572)：复用已有 Base UI Dialog，Portal 保持在播放器根下，添加遮罩、焦点陷阱、当前集初焦点、关闭归还 Trigger；面板/菜单打开时隔离全局快捷键。 | 同一交互回放原实现失败；修后逐 Tab 遍历三次开关、ArrowRight 不改变暂停进度、Escape 归焦。R3 真包又做六轮真实起播与选集开关，不只靠 fixture。 |
| WIN-04 一般 | 解绑 pointermove 时读取已清空的 `root.current`，不能保证移除原节点 listener。不能仅据这一行直接宣称整个应用已发生内存泄漏。 | [Player.tsx:278](../src/renderer/Player.tsx#L278)：effect 捕获注册时根节点，cleanup 用同一节点；已有 idle/OSD/volume timer 和 bridge 订阅一并核对。 | R3 六轮真包进入/离开播放器，root/video WeakRef 全部回收，应用 window/document listener 集合与基线相同，活动 timer 集合为空且与基线一致；这是有限窗口证据。 |
| WIN-05 严重 | 与 TV 同根：主搜索失败但回退为空时可能显示假空结果，首字母查询错误被 fulfilled 空数组吞掉，立即重试仍跳过主接口。 | [douban.ts:492](../src/main/data/douban.ts#L492)：失败与避让一起保存；无已验证匹配时传播原可重试错误；未恢复结果就清除避让；不修改匹配身份或播放核心。 | 同一双端搜索复现先红后绿，桌面 search-recovery 七项通过；全套离线 19 文件/285 项通过。 |
| WIN-06 优化 | 选集大面积 backdrop blur 和不必要的布局动效增加重绘负担。 | [app.css:48](../src/renderer/app.css#L48)：抽屉用 translate、遮罩用 opacity；移除该面板 backdrop-filter，没有把 TV 全局焦点样式加进桌面。 | 真包选集开/关 rAF 样本 p95 4.3ms、max 8.3ms、0 个 >20ms 间隔；不把这项局部结果写成整个桌面稳定 60fps。 |

没有其他经独立复核确认的桌面遮挡/不可达阻断项。问题少并不是漏审；桌面现有多数结构在鼠标键盘下合理，无须套用 TV 六列导航或 5% 页边。

## 逐页与组件核验

| 页面 / 控件 | 已执行的检查 | 依据与边界 |
| --- | --- | --- |
| 窗口外壳、首页/推荐、横向海报行 | 真包 1440×900 与 1080×640 内容尺寸、原生最大化/恢复记忆、窗口按钮命中、真实主推/海报加载、首页 More/滚动与悬停；fixture 另覆盖布局窗口组合。 | ASAR 路径/哈希、renderer chunk、真实窗口 contentSize/DPR 有留档；没有把 viewport 仿真单独当 Windows 系统缩放测试。 |
| 五频道、分类/筛选、排序、分页 | 真实 Douban categories/sorts、校园筛选与下一页、真实数据与标题；fixture 展开/关闭、分页回顶、错误与空态。 | 筛选值来自真实 taxonomy；设计契约通过不等于真实 API 验收。 |
| 搜索联想、热搜、历史、首字母、搜索结果 | Ctrl+K、ArrowUp/Down、Escape、Enter、结果分类/Tab、真实首字母与 Chinese 查询；清空、错误、离线有确定性测试。 | fixture 只证明这些状态渲染；live 的真实查询与可见结果另行记录。 |
| 详情、演职员、影人作品、相关推荐、选集 | 真“三体”详情、收藏、主要影人/照片及作品列表；真实第 1→2→3 集解码，选集与下一集触发。 | 没有注入虚构上映年、剧集数或播放地址；三集通过不代表每个目录永久可用。 |
| 收藏、历史、删除/撤销、空态 | 真包收藏“三体”、历史空态；fixture 覆盖删除/撤销、进度卡、状态持久化相关交互。 | 使用隔离测试 profile，未清空用户真实收藏/历史；未把种子截图命名为 production。 |
| 设置、开关、倍速菜单、更新、清空确认 | 真包默认倍速菜单、清空历史确认初焦点/Trap/Escape 归还，模态出现时窗口按钮仍可命中；fixture 额外遍历设置状态。 | 更新未配置是实际可见状态，不伪称发现/安装新版本。 |
| 播放器、进度/音量、选集抽屉、倍速/线路/清晰度菜单 | 真包六轮播放器与模态往返、暂停/恢复、三集转换；fixture 覆盖 seek/volume/质量/线路失败与保留旧画面、intro/up-next/重试、拖动、全屏相关控制。 | 当前真实流未提供独立多清晰度或字幕轨样本；fixture 的多档列表不能充当真实源证据。 |
| Toast、OSD、骨架/图片失败/错误/重试 | fixture 离线、加载、空态、失败与恢复逐项实际渲染；真包监听/定时器有限窗口测量。 | 真实网络失败与同一 API 成功空响应分开；不把页面空白当“无结果”。没有不存在的独立字幕面板。 |

## 真实测试结果与性能

- 2026-11-21 17:59 以 Node 24.14.0 重新构建，typecheck 和 build 通过，逐字节比较 `out/` 与 R3 ASAR 内的 216 个文件，差异为零。离线 19 文件、285 项通过，206 个设计文件摘要和 405 项契约检查通过。
- 独立重放 R3 的原生窗口交互用例通过，用时 8.9 秒。窄窗请求为 1080×640，系统实际内容尺寸为 1080×642，DPR 1.5。搜索联想打开时所有被测顶栏按钮仍可命中，Escape 保留输入焦点，设置确认关闭后焦点归还触发器。
- R3 fixture：19/19，5.5 分钟，一个隐藏生产 renderer；与 live 输出目录、报告标题分开。
- R3 完整 packaged-live：**8 passed / 6 failed / 1 skipped**，9.0 分钟。真实数据、影人、首字母、剧集三集、包 UI、再启动/最大化和 360 单源用例通过；不能写成完整 E2E 全绿。
- 三个强制单源 bfzy/dyttzy/lzi 与动画在初次等待解码阶段超时；电影初次起播成功，但 seek 到 500 秒后 25 秒内仍不推进（读到 500.000068）。该电影失败在倍速测量之前，不能再归因成倍速不达标。
- 第六个失败是新资源探针把 Playwright 自己安装的 13 个全局捕获 listener 当作产品泄漏。已按实际 scriptId 与保留事件同源关系分组、保留应用 listener 的严格断言；独立重跑 1/1 通过。完整原批次仍保留 6 个原失败，不重写成 8/13 等新总数。
- 正确资源复核中的四段 rAF：搜索 p95 4.7ms/max 75.1ms，首次悬停/滚动 4.3/100ms，详情进入 4.4/45.9ms，选集开关 4.3/8.3ms；前三段各有 2–3 个 >20ms 间隔，longtask Observer 未记录任务。它不是 GPU 帧输出、实体高刷撕裂或每帧 16.6ms 达标证明；未做冷/暖 trace 归因，不据此臆造桌面严重性能缺陷。
- ASAR 检查 271 项，无 mock/art/preview、fixture、tests、scripts、source maps 或 node_modules。新 NSIS 没有安装，不报告安装/卸载成功。

另外独立执行同一个 R3 包的 movie/serial/animation 用例：**2 passed / 1 failed**。电影 seek 到 500 秒后 1891ms 恢复推进；12.009 秒墙钟推进 23.890406 秒，实测速率 1.989×，573 个解码帧、2 个丢帧（0.349%），原生全屏/PiP、关闭 flush 和再次启动的约 528 秒历史通过；《三体》第 1→2→3 集实际解码通过。动画这轮在首次解码等待 65 秒超时，保留该失败。

动画再独立执行一次：**1 passed，40.9 秒**，真实检索选择的是 `db-37457082 / 凡人修仙传 年番4 / anime`，1920×1080、27 解码帧、0 丢帧。新诊断会在失败时保存初态和可见 Retry 的后续观测，并仍抛原失败；这次通过没有进入该 catch/Retry 分支，**不能声称真实动画 Retry 已验收**，也不能把后来一个不同身份/源的成功解释为较早网络失败“已修好”。以上都是附加样本，不重写完整 R3 批次的 8/6/1。

视觉复查也读取了真包的窄窗搜索、设置、详情/演职员、影人作品、频道、电影控件及剧集截图。部分列表图在图片懒加载期间拍摄，含尺寸保持的空海报框；它们证明布局不塌陷，不证明每张上游图片均加载成功。隐藏 fixture 的加载/空/错误/离线和选集截图另行审阅，不冒充这些真实目录页面。有限测试窗口没有 pageerror，不能推广为所有外网、所有时长零错误。

## 重放

```powershell
npm run build
npm run test:e2e:fixture
$env:PANDA_E2E_EXECUTABLE = (Resolve-Path '.tmp/frontend-audit/windows-r3/win-unpacked/Panda.exe').Path
npm run test:e2e
```

需要只跑修复回归时传入 `e2e/packaged-ui.spec.ts`、`e2e/runtime-ui.spec.ts` 或 `e2e/live.spec.ts`。每次使用新 evidence/output 目录，不覆盖唯一失败证据；所有 Electron 用例串行。详细材料见[证据索引](evidence/runtime/frontend-audit/README.md)。
