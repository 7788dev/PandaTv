# Android TV 操作体验排查

2026-11-26 在当前工作区构建并验证 TV 1.0.14（versionCode 15），包含尚未提交的播放规则改动。设备为全新安装的 MuMu Android 15 / API 35，应用横屏为 1920 × 1080。首页、搜索、详情和播放走真实上游。另在源码副本中控制目录和媒体的网络响应，核对失败原因与实际请求次数。

下文记录修复前的复现结果。后续逐项验证见[修复报告](tv-ux-fixes-2026-11-26.md)。

## 影响找片和播放的主要问题

### 1. 首次安装后，首页会丢掉已经加载的栏目

首次安装的会话中，遥控器连续向下，到“热播剧集”的《两京十五日》就停住了。重启同一安装后，可以从同一张卡片继续走到三组榜单、最新电影、综艺、动漫和纪录片。

冷启动的数据服务保存最先可展示的首页，随后通过回调陆续提供更多栏目。整批协程结束后，页面又把最早那份首页赋回界面。用受控响应验证，回调里已有动漫和纪录片，最终返回值却少了这两栏。另一个用例只让新片榜返回 404，剧集接口已返回条目，整张冷启动首页仍然报错。[首页接收与赋值](../tv/app/src/main/java/app/panda/tv/ui/HomeScreen.kt#L131) · [首批结果的生成](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt#L274) · [失败分支及最终返回值](../tv/app/src/main/java/app/panda/tv/data/DoubanDataSource.kt#L297)

### 2. 播放失败后，用户按“重试”可能连续五分钟都试不到可用线路

受控用例中，唯一一条线路能返回有效媒体。模拟一次播放卡顿后，错误页“重试”所调用的方法立即失败，新增媒体请求 **0 次**。在同一服务中显式指定这条线路则立即成功。错误页只有“重试”和“返回”，用户在这里无法指定线路。

还有一条能从正常操作触发的路径。进入播放器等待媒体探测，2.7 秒后退出，服务把用户取消的请求记成线路探测失败。随即打开另一部作品，同一线路也被跳过，仍然是 0 次媒体请求。原因是冷却按片源全局记录，默认持续 300 秒，错误页按钮始终传入空的指定线路。[错误页按钮](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L987) · [退出竞速时记录失败](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L759) · [筛除冷却线路](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L718) · [冷却参数](../tv/app/src/main/assets/rule-calibration.json)

### 3. 检查片源的等待期限和真实网络请求脱节

实测打开国产《三体》第 1 集。第一次按播放，约 **22.1 秒**后检查浮层消失，仍停在详情。稍后选集出现，再次按播放，约 **5.3 秒**后时钟走到 `00:01 / 43:42`。同次目录日志中，红牛请求耗时 16.9 秒、量子 20.5 秒、电影天堂 32.1 秒。

单个目录标称 9 秒超时，但域名解析、连接和读取走阻塞调用，协程期限不能保证整个请求在 9 秒内退出。页面自己的 22 秒期限独立生效，后台共享查询还可以继续，迟到的结果也不会恢复用户刚才那次播放操作。上述耗时是本轮网络样本。[页面等待期限](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L390) · [目录请求](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1356) · [网络连接](../tv/app/src/main/java/app/panda/tv/net/PublicNetwork.kt#L149)

### 4. 红牛线路的实际播放画面出现博彩推广

《三体》第 1 集在 `00:01` 的截图中已经出现博彩站点赞助文字，控制栏同时显示“线路: 红牛资源”和 1080P。TV 的过滤逻辑依据播放清单的标记、路径和分片特征，红牛在内置配置中的专属路径和指纹都为空。截图确认了这次曝光，广告是否独占一个可安全剪除的分片仍待核实。[实际画面，见末行左图](evidence/tv-ux-audit-2026-11-26/tv-screens.webp) · [清单过滤](../tv/app/src/main/java/app/panda/tv/playback/PlaylistFilter.kt#L137) · [内置片源配置](../tv/app/src/main/assets/play-sources.json)

### 5. 较慢的目录补齐集数和线路后，当前页面不会跟着更新

用两个目录验证，快源只给第 1 集，首次查询得到 1 条线路、集数为空。慢源完成后，在同一服务里重新查询就有 **5 集、2 条线路**。后台已经更新缓存，但详情页只在加载时取一次可播集数，播放器也只在起播后取一次线路列表。只收到早期结果时，详情可能直接隐藏选集，播放器也会隐藏线路按钮。用户留在当前页面就看不到后到的选择。[后台补全](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1292) · [详情读取集数](../tv/app/src/main/java/app/panda/tv/ui/DetailScreen.kt#L152) · [播放器读取线路](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L869) · [线路按钮显示条件](../tv/app/src/main/java/app/panda/tv/ui/PlayerScreen.kt#L1140)

### 6. 目录恢复后，连续重试会推迟下一次真正的请求

目录连续失败三次后进入 30 秒冷却。用例让上游随即恢复，在第 16 秒和第 31.5 秒分别重试，两次都报告“暂时无法连接”，新增目录请求 **0 次**。冷却检查抛出的异常又被同一个失败处理分支计数，并从当下重新计算 30 秒。持续点重试或连续打开不同作品都可能延长等待。这是目录层的计时，和第 2 项媒体线路的五分钟冷却独立。[目录冷却检查](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1350) · [失败后重设计时](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1399)

## 遥控器、搜索和设置

| 用户操作 | 实际表现与影响 | 对应实现 |
| --- | --- | --- |
| 打开影片详情 | 《三体》和《八仙！》都自动聚焦“播放”，首屏从导演一行开始，片名、年份和返回按钮被滚到屏幕上方。《三体》从播放键向上两次才看全片名、评分和年份。同名作品尤其难以确认。 | [详情首焦点](../tv/app/src/main/java/app/panda/tv/ui/DetailScreen.kt#L436) · [前后截图](evidence/tv-ux-audit-2026-11-26/tv-screens.webp) |
| 从搜索页进设置，确认清空搜索记录，再按返回 | 设置提示“已清空”，原搜索页仍显示“三体”和“ST”。退出并重新进入搜索，两条记录才消失。共享电视上，其他人仍能在旧页面看到刚删除的词。 | [清空操作](../tv/app/src/main/java/app/panda/tv/ui/SettingsScreen.kt#L119) · [搜索页构建最近记录](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L395) |
| 在已有 `ST` 搜索结果上重新编辑，退格删完，再按返回 | 输入框变空，结果网格和类型筛选一起消失，页面停在热搜。编辑中删掉最后一个字会立即清掉原查询和结果，返回键失去恢复依据。 | [空输入处理](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L201) · [清掉查询快照](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L268) · [返回逻辑](../tv/app/src/main/java/app/panda/tv/ui/SearchScreen.kt#L144) |
| 从详情切到系统桌面，再打开应用 | 保留进程时回到《八仙！》详情。模拟系统回收后台进程后，Android 仍恢复任务 7，但应用落在首页，原详情和焦点丢失。低内存设备上需要重新找片。 | [页面栈](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L44) · [Activity 创建入口](../tv/app/src/main/java/app/panda/tv/ui/MainActivity.kt#L100) |
| 在设置中打开“自动跳过片头片尾” | 代码核对发现，当前 HLS 和 MP4 播放结果均未填入片头、片尾时间点。设置能保存，但规则拿不到执行跳过所需的数据。 | [设置开关](../tv/app/src/main/java/app/panda/tv/ui/SettingsScreen.kt#L92) · [规则所需字段](../tv/app/src/main/java/app/panda/tv/model/Rules.kt#L159) · [MP4](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1079) · [HLS](../tv/app/src/main/java/app/panda/tv/playback/PlaybackService.kt#L1228) |
| 在设置中按“检查更新” | 实测固定提示“更新服务未配置”。按钮的处理函数只显示提示，用户无法在 TV 内查询新版本。 | [版本行点击处理](../tv/app/src/main/java/app/panda/tv/ui/SettingsScreen.kt#L130) |

## 验证记录

- 重新运行 TV 单测，145 项全部通过。release 构建通过，Android lint 为 0 个错误、34 个警告。安装在模拟器上的 APK 与本地 release 产物 SHA-256 一致。
- 6 个独立用例运行在相同源码的临时副本中，只替换元数据、片源目录或媒体请求的响应。用例断言的是本报告观察到的异常行为，输出保留了请求次数、返回栏目、集数和线路数。在 TV 源码副本中将用例放在 `AdmissionFixture.kt` 同目录，从副本的 `tv/` 运行 `.\gradlew.bat :app:testDebugUnitTest --tests '*AuditProbeTest'` 即可复核。[用例源码](evidence/tv-ux-audit-2026-11-26/AuditProbeTest.kt) · [运行结果与设备观察](evidence/tv-ux-audit-2026-11-26/observations.json)
- 《三体》已经显示视频并推进时钟，随后进入播放错误页。《八仙！》也观察到短暂起播后报错。两次现场故障的具体触发原因未由日志定位。长时间播放稳定性、实体电视上的解码与遥控器差异仍待验证。[现场对照截图](evidence/tv-ux-audit-2026-11-26/tv-screens.webp)
