# 当前构建的真实网络证据

这组文件属于当前 `out/` 构建上的真实 bridge/网络回放，使用层级与结论由[审计报告](../../../usage-audit-2026-11-22.md)说明，完整 Playwright 批次见 [live-result.json](../live-result.json)。

| 文件 | 内容 |
| --- | --- |
| [live-data-1.json](live-data-1.json) | 影片与影人元数据、频道筛选、联想、分页样本 |
| [movie-controls.json](movie-controls.json) | 实际解码、seek、手动倍速、窗口控件 |
| [movie-persistence.json](movie-persistence.json) | 隔离测试 profile 中的收藏与历史持久化 |
| [serial-playback.json](serial-playback.json) | 可播集数与连续切集的实际解码 |
| [movie-controls.png](movie-controls.png) / [serial-playback.png](serial-playback.png) | 对应运行截图 |

构建文件摘要保存在 [validation.json](../validation.json)。这组证据不属于用户安装或 packaged executable 的验收。
