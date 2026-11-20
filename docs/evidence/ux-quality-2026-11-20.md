# PandaTv UX 与品控回归（2026-11-20，UTC+8）

本轮发布对应 Windows `1.1.0` 和 Android TV `1.0.7`。完整数据及原始报告位于 [`runtime/quality-1.1.0-tv-1.0.7/`](runtime/quality-1.1.0-tv-1.0.7/)。Windows 冷启动由 20 次空用户目录启动和 3 次复用目录启动测量；TV 实机替代环境为 MuMu Android 15、1920×1080 横屏、60 Hz。它不能代替 TCL Android 5.1 真机结果。

## 优先级与本轮落地

| 优先级 | 发现 | 处理与验收 |
| --- | --- | --- |
| 高收益 / 低成本 | 目录池有 9 个内置源，而检索并发只有 8；前面的请求占满时最后备用源无法开始。 | 桌面和 TV 并发容量都提高到 12；新增 TV 回归把前 8 个请求挂起，断言第 9 个源仍能开始并返回。把容量暂时恢复到 8 时新测试超时，恢复到 12 后通过。 |
| 高收益 / 低成本 | Electron 最大化状态未持久化。 | 记录最大化状态与正常窗口几何，调整窗口时 250 ms 防抖保存；打包可执行文件重启 E2E 通过。 |
| 高收益 / 中成本 | 筛选展开、多页加载后的回顶边界缺少回归。 | 桌面在三种窗口尺寸、五个频道逐项展开筛选、加载下一页并回顶，量测首行卡片与筛选区间距；另测首页、频道、详情、我的、设置、搜索面板、菜单和对话框边界、死链及错误事件。5 项布局用例通过。TV 五个频道及搜索、影人、收藏、历史导航完整回归通过。 |
| 中收益 / 中成本 | TV 遥控器播放器右侧面板的边界键可能漏到面板背后的控件。 | 将边界键处理前置到焦点拦截；播放器焦点回归通过。 |
| 中收益 / 中成本 | TV seek 后的 decoder operating rate 缺少缓冲期管理；倍速掉帧观察只能依赖逐次主观感觉。 | 进度拖动及左右 seek 使用 Media3 scrubbing mode；缓冲结束并安静 320 ms 后关闭，持续缓冲最长 15 秒后恢复普通模式。使用 Media3 动态调度；倍速计数读取播放器 video decoder 的 rendered/dropped buffer counter，并用 frame processing offset 作为辅助。Android 单测、lint、release 构建通过。 |

## 量化结果

| 指标 | 既有基线 | 本轮实测 | 结论 |
| --- | --- | --- | --- |
| Windows 冷启动到首页数据可见 | 24 次，median 702 ms，worst 1007 ms | 20 次，median 782 ms，p95 1293 ms，worst 1430 ms | 中位数增加约 80 ms；启动逻辑未改，本轮结果略慢，不能宣称冷启动改善。20 次都成功。 |
| Windows 冷启动首屏 18 张可见图解码 | median 1345 ms，worst 3071 ms | median 1027 ms，p95 1523 ms，worst 1525 ms | 中位数约快 318 ms；此轮未更改图片加载实现，变化来自不同运行样本与时序。 |
| Windows 冷启动完整首页 | median 1754 ms，worst 2865 ms | median 1695 ms，p95 1902 ms，worst 2427 ms | 中位数约快 59 ms；20 次无失败。 |
| Windows 同目录重启首屏图像 | 既有记录 18 张图完整加载 | 3 次 median 709 ms，range 665–718 ms | 3/3 完成。 |
| Windows 实际播放 1.5× | 无逐段解码帧基线 | 6.0 s wall / 8.93 s media，observed 1.49×；213 decoded、2 dropped，drop ratio 0.93% | 该片段、该机器、该次播放达到倍速目标；不是跨设备保证。 |
| Windows 真实影片 500 s 跳转后恢复 | 既有单次 1867 ms | 本轮单次 3875 ms | 本轮未达到 2 s 目标，且比旧样本慢；seek/网络缓冲仍需优化。 |
| TV 连续 seek 恢复 | 无同设备量测基线 | 360zy 单源一次连续 6 次遥控器 seek 后，缓冲结束至时间轴继续前进 5,375 ms | 这是命令 burst 的一次观测，不等价于单次 seek latency；实际体验仍受分片源与网络决定。 |
| TV 冷 activity 启动 | 既有 TCL 设备历史记录 630 ms（环境不同） | MuMu 5 次 `am start -W TotalTime`：156–193 ms，median 164 ms | 仅系统 activity 启动时间，不包括首页网络数据和首屏海报，不可与实体电视直接比较。 |
| TV 首屏 / 展开筛选导航动画 | 既有 MuMu 2 轮、4 场景 0 janky，p95 5 ms | 4 场景各 0 janky，p95 均为 5 ms | 在这台模拟设备上复现；未覆盖低端实体电视性能。 |
| TV 2×实际帧率 | 无已验证帧率基线 | 最终 APK 单源 360zy 下媒体时间 12.64 s 前进 23 s（实测 1.82×）；10 s decoder counter 记录 577 rendered output buffers / 0 dropped output buffers | 该 MuMu / 360zy 样本的 dropped-buffer ratio 为 0/577；不代表所有编码器、片源或实体 Android 5.1 电视。全源网络测量仍受境外出口的超时与 403 限制。 |

Windows 测量来自打包的 `Panda.exe`；TV release APK 为 1,072,144 字节，SHA-256 `242F249E0A21D72DEB3F007342E9E6609EE9151F081715DD44FEB999FD52A498`（`1.0.7`, versionCode 8, minSdk 22），MuMu 安装文件哈希与发行 APK 相同。启动原始数据见 [`desktop-startup-1.1.0.json`](runtime/quality-1.1.0-tv-1.0.7/desktop-startup-1.1.0.json)，播放器数据见 [`desktop-live-movie-1.1.0.json`](runtime/quality-1.1.0-tv-1.0.7/desktop-live-movie-1.1.0.json)。

## 产品面与播放源

内置的 9 个源为速播、虎牙、暴风、电影天堂、量子、非凡、红牛、金鹰和 360。搜索目前每源 9 秒超时，命中后最多再等 1.2 秒收集其它目录；起播并发比较最多 3 条线路，按首片传输余量、实测画面与作品级近期失败降权排序；线路失败最多自动重试两次。解析器继续处理 HLS/MP4、密钥和清单 URI，去广告规则只删除有清单内证据的片段。应用不要求用户填写源地址或提供账号凭据。

本机出口的 `probe:start` 在 16 个真实热门条目中有 13 个读到首片，成功样本总耗时 median 2442 ms、worst 4408 ms；获胜源 360zy 13 次。探测同时看到虎牙、金鹰 403，红牛连接重置，多个其它目录超时。这里是境外出口证据，不代表国内目录可用率；北京网络/目标 Android 5.1 电视仍需单独实测。证据见 [`desktop-source-probe-1.1.0.txt`](runtime/quality-1.1.0-tv-1.0.7/desktop-source-probe-1.1.0.txt)。

TV 导航覆盖 23 项、搜索清空 3 项全部通过，user-state 恢复标志为 true；焦点清单、搜索与动画报告见 [`tv-navigation-1.0.7.json`](runtime/quality-1.1.0-tv-1.0.7/tv-navigation-1.0.7.json)、[`tv-search-1.0.7.json`](runtime/quality-1.1.0-tv-1.0.7/tv-search-1.0.7.json) 和 [`tv-motion-1.0.7.json`](runtime/quality-1.1.0-tv-1.0.7/tv-motion-1.0.7.json)。最终哈希 APK 下 360zy 单源切集到第 3 集并更新历史通过。2.0×实测为 media time 1.82×（12.64 s wall / 23 s media），10 秒 decoder counter 为 577 rendered output buffers、0 dropped output buffers；仅代表 MuMu Android 15 / 360zy 样本。九源报告 [`tv-playback-1.0.7-final-run.json`](runtime/quality-1.1.0-tv-1.0.7/tv-playback-1.0.7-final-run.json) 中焦点、切集、无源重试通过，倍速因该次未解出首帧而不可测。上述报告的 user-state、防火墙、临时源规则恢复标志均为 true。

Windows 安装器已在一台原有安装机上从 1.0.0 原位升级到 1.1.0，程序目录和快捷方式存在，安装进程退出码为 0；该已有安装未卸载，用户数据未清除。安装记录为 [`desktop-install-1.1.0.txt`](runtime/quality-1.1.0-tv-1.0.7/desktop-install-1.1.0.txt)。

## 验证与剩余风险

- `npm run typecheck`、`npm test`：235 项通过；`npm run verify:design`：206 个设计文件未变；契约测试 405 项通过。
- `npm run dist` 成功，`asar-check` 为 268 项且未打入 node_modules、原型 mock/art/preview、测试、脚本和 source map。已安装版本的真实影片及 startup E2E 通过。
- 打包 Windows 全量 Playwright 为 21/24 通过。3 个失败是强制单源 bfzy、dyttzy、lzi 的广告播放测试，均在 65 秒等待解码首帧时超时；360zy 同类通过。不能宣称全量 E2E 全绿。
- TV `testDebugUnitTest` 23 项、`lintRelease` 与 `assembleRelease` 通过；lint 有 35 项 warning、0 error。MuMu Android 15 的导航、搜索、动画和选集成功样本不能替代 TCL Android 5.1 实体机。
- 尚未完成：在真实国内网络进行多源播放/seek 测试；实体 Android 5.1 TV 与低端 Windows 设备长时间播放和温度/内存实测；Windows 安装器完整卸载循环（本次升级机原本已有安装，未移除用户已有安装）。TV 2× decoder buffer 与丢帧计数已在 MuMu Android 15 单源实测，尚未在目标 TCL 设备、多源与长时间播放中量测；签名证书和在线更新服务仍缺失。
- 本轮未改设计文案资源；3×13 遥控器搜索键盘、热搜首页、空/错/离线/重试状态和设计契约均沿用既有实现。桌面多尺寸及频道筛选回归覆盖了布局，但不等于所有控件和物理屏幕的穷举。
