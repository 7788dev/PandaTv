# 诊断源快照

这些文件是本次实际运行的诊断源归档；结果与期望修复行为以[审计报告](../../../usage-audit-2026-11-22.md)为准，取证时的源码摘要见 [validation.json](../validation.json)。断言检查的是“当前故障存在”，正常退出不表示修复成功。正式回归须保留相同操作/时序并断言报告中的期望结果。

源文件依赖仓库内的相对路径和临时目录布局，不能直接在这个归档目录执行。先把对应文件逐个恢复到仓库根下的 `.tmp/usage-audit-2026-11-22/`；Kotlin 文件保留 `tv-probes/app/panda/tv/UsageAuditProbeTest.kt` 布局。运行前使用 Node 24、当前依赖和与待验证源码对应的 `out/` 构建。所有 Electron 回放串行运行。

## 业务逻辑与隐藏 renderer

从仓库根执行：

```powershell
.\node_modules\.bin\esbuild.cmd .tmp/usage-audit-2026-11-22/data-probes.ts --bundle --platform=node --format=esm --log-level=warning --outfile=.tmp/usage-audit-2026-11-22/data-probes.mjs
node .tmp/usage-audit-2026-11-22/data-probes.mjs replay
node .tmp/usage-audit-2026-11-22/ui-probes.cjs replay
node .tmp/usage-audit-2026-11-22/speed-load-probe.cjs
node .tmp/usage-audit-2026-11-22/desktop-corrupt-state.cjs
```

`ui-probes.cjs` 和倍速探针需要同目录的 `extended-fixture-main.cjs`，使用当前生产 renderer、本地 MP4 和隔离数据。损坏状态探针使用真实 main/preload 和新建隔离 profile，不应改成用户 profile。输出保存在临时目录；归档证据不要用重放结果覆盖。

## TV JVM 诊断

在 `tv/` 工作目录执行：

```powershell
.\gradlew.bat testDebugUnitTest --rerun-tasks --offline --console=plain -I ../.tmp/usage-audit-2026-11-22/extra-tv-probes.gradle
```

init script 把临时 Kotlin 测试追加到当前 AGP 的 test source set，不写入生产或正式测试目录。它只做 JVM 验证，不构建或安装新的 release APK。

## 已安装 APK 的写失败探针

`tv-storage-probe.py` 依赖仓库 [tv_runtime_helpers.py](../../../../scripts/tv_runtime_helpers.py)、uiautomator2 和可执行临时权限故障注入的测试设备。它会备份状态、验证真实设置焦点、临时改变 files 目录权限，再在 finally 中恢复。运行设备部分应先完整执行[TV 回放工作流](../../../../.agents/skills/tv-runtime-regression/SKILL.md)的身份核对、状态保存和独立恢复步骤，并保持开始时的实例开关状态。

脚本从原临时路径运行时接收 `--serial <测试设备序列号>`。它产生的 `private-original-user-state.json` 含完整用户状态，只能留在忽略目录；不能加入证据、提交或用归档目录作为输出位置。本归档只含源代码，没有该备份。
