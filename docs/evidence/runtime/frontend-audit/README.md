# 2026-11-21 前端审查运行证据

状态：R12 build 与 TV 静态页、导航、搜索、焦点、翻页和动画回放已完成；播放器在最新批次中遇到真实目录/媒体不可用与 MuMu 自动化服务异常，未全部复证。这里收集审核过的真实运行记录，而不是发布“全绿”清单。分端结论：[TV](../../../frontend-audit-tv.md)、[Windows](../../../frontend-audit-windows.md)，验证误判与清理：[证据审阅](../../../ui-evidence-review.md)。

## 包身份

| 身份 | SHA-256 | 用途 |
| --- | --- | --- |
| 原发布 TV 1.0.12 | `8AD82282BDDA56C1203F06685734FEBD2874E2C57128E6D646EE35C1C4D8E974` | 审查前复现 |
| TV R5 | `D3C0E935650F1DB6394CB3D9BBAB1773F70B9AEF154F759080FEABAC2B4FEE9B` | 严格 5% 初步通过；仍有 Retry/驱逐焦点和真实播放失败 |
| TV R6 | `06E6F2CA5F974C2E3211DDCA910D45F3D133C54CD6AE82792316367B54AC65D4` | 驱逐排序恢复；原三尺寸深处卡片基线不合法，该失败归因撤回 |
| TV R12 | `7C00233AFF37F5E964315CF66CDEB90D589FDA502C230C383C7E841B606ABEED` | `Panda-TV-audit-r12.apk`，已实际安装；尺寸、导航、搜索、分页、动画使用同一 APK 摘要 |
| Windows R3 ASAR | `27C4028F5C6B577C224F2B1DD5B0AAD3252CC98C7EBF0CAEB3772E2795A28CE4` | 真包 unpacked UI/live 回放 |
| Windows R3 NSIS | `977D29F32A8A86FE80EF68E34A0B81BEF16DDE429C02212D1E2CE109EEEC8EC9` | 已生成，未安装 |

候选位于仓库 `.tmp/frontend-audit/`；原发布包 `release/` 没有覆盖。TV 均沿用 versionName 1.0.12；版本名不是字节身份证明。Windows 生产 renderer chunk 为 `index-DhwGucV8.js`。

## 阅读顺序

1. `checks/`：构建/离线/设计基线、旧 Gradle wrapper 假成功红绿、双端搜索错误红绿、清理清单与完整 Windows 批次失败日志。
2. `tv/`：原包和历史中间包 before；R5 旧候选播放器样本；R11 deadline 与播放器阶段样本；R12 三尺寸、修正后的完整导航、搜索错误、续页恢复、查源超时、动画及最后一次失败/不可用播放器批次。每份 JSON 保留自身包 hash、时间和 cases/failures/unavailable，不跨版本合并成一个通过率。分页还保存了早期无效标题探针与严格重跑。
3. `windows/`：窄窗 before、R3 真实包截图/状态、正确的六轮资源检查、独立真实 movie/serial/animation 回放。`fixture` 与 `report-labels` 不证明生产接口或安装。

最终推广清单和每个文件的来源/哈希写入 `manifest.json`。不推广用户 profile、完整原始用户状态、Cookie 或签名媒体地址；截图与当前 PID 的日志也只作对应场景证据。

## 直接查看

- [R12 修正后完整方向键回放](tv/tv-navigation-r12-complete/report.json)：23 项无失败并恢复原测试状态。
- [分页重试回放](tv/tv-pagination-r12-verified/report.json)与[频道末行 Retry 实机截图](tv/tv-pagination-r12-verified/channel-retry-focused.png)。
- [R12 播放批次](tv/tv-playback-r12-final/report.json)和[UiAutomationService 原始崩溃日志](checks/tv-crash-all-r12-final.log)：保留实际通过、未测和失败阶段。
- [Windows packaged-live 原批次](checks/windows-live-r3.log)和[Windows 分端审查](../../../frontend-audit-windows.md)：与 fixture 结果分别记载。

## 已知非全绿项

- Windows R3 完整 packaged-live：8 passed / 6 failed / 1 skipped。资源探针的一个假阳性已单独纠正并重跑通过，不改写原批次。其余五项播放在各自阶段未达标。
- TV R12：三尺寸各 8 项 surface 检查、23 项导航、6 项 More、4 项搜索错误/焦点、4 项标题搜索、首屏/频道/影人三组分页、2 次查源 deadline 与 881 个 motion gfxinfo 帧通过；该批次分页、搜索和焦点均检查真实节点和恢复结果。
- TV R12 播放：完整批次 3 passed / 2 unavailable / 10 failed。三项已执行的通过为播放器焦点、查源取消和真实目录中的 missing-source 检查；两个 unavailable 和十个 failure 不计为播放成功。新播放器抽测在选集面板打开前又遇到真实 Retry。MuMu crash 缓存记录的是 `uiautomator dump` UiAutomationService 重复注册，不是 Panda 进程；原批次现场、完整输出、设备恢复报告一并保存。
- 独立的同播放器实现 R11 完整批次：10 passed / 1 unavailable / 4 failed。两项详情 Back 因旧脚本固定等待已被焦点对齐移出的集号而未执行；两项断网重试的播放恢复仍失败并保留。另有一份 R10 详情焦点回放实际通过，R11 截止时间样本独立两轮均观测到约 40 秒 Retry，并在恢复网络后推进。R12 的线路、详情、真实播放不可因 R11 成绩而记作已执行。
- TV R5 更早的 Retry 焦点与跨频道驱逐排序失败是历史真缺陷。R6/R7 旧深处卡片基线被 helper 改变的问题已撤回。分页早期探针也误把评分/占位文本当成新片名；只认可新的标题控件回放。

## 重放约束

通过 MuMu `info --vmindex 1` 获取实际 serial，显式安装所选 APK，单设备串行执行 `scripts/verify-tv-*.py`；首字母/目录/媒体都用真实数据。保存并恢复完整用户状态、源覆盖、IPv4/IPv6 OUTPUT 规则和 wm size/density，不清空 logcat 或应用数据。R12 结论只对应 Android 15 MuMu，不代表实体电视解码性能。

Windows live 指定真实 `PANDA_E2E_EXECUTABLE`，fixture使用 `npm run test:e2e:fixture`，不要再运行 `design/preview`。live仅一窗口；fixture仅一隐藏窗口；报告不自动打开。每次新标签/目录，保留唯一失败，最终通过也只覆盖实际执行的断言和环境。
