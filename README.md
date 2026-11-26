# Panda

Panda 提供 Windows 桌面客户端和 Android TV 遥控器客户端。可以浏览影视目录、按片名或首字母搜索、收藏和续播。播放线路和可选集数取决于当前片源。下载已发布的 Windows 安装程序或 TV APK 可前往 [GitHub Releases](https://github.com/7788dev/PandaTv/releases)。

## 从源码运行

Windows 使用 Node.js 24 和 npm。首次检出后在仓库根目录运行以下命令。

```powershell
npm ci
npm run dev
```

TV 使用 JDK 21、Android SDK Platform 37 和 Build Tools 37.0.0。在 Android Studio 配置 SDK，或设置本机的 `ANDROID_HOME`。

```powershell
cd tv
.\gradlew.bat assembleDebug
```

调试包位于 `tv/app/build/outputs/apk/debug/app-debug.apk`。最低系统版本为 Android 5.1（API 22）。

## 代码与验证

| 模块 | 实现与检查 |
| --- | --- |
| Windows 界面 | [React 页面和样式](src/renderer/) 通过 [preload](src/preload/index.ts) 与主进程通信。运行 `npm run build` 后可用 `npm run test:e2e` 串行验证真实上游。 |
| 数据与播放器 | [主进程](src/main/) 负责目录、持久化、探测和媒体代理。运行 `npm test` 检查行为，`npm run check:rules` 检查规则参数。 |
| 桌面离线交互 | 安装 FFmpeg 后运行 `npm run test:media` 生成测试媒体，再运行 `npm run build` 和 `npm run test:e2e:fixture`。测试使用编译后的 Electron 应用、网络边界数据和可解码视频。 |
| Android TV | [Kotlin 客户端](tv/app/src/main/java/app/panda/tv/) 使用原生 Views、Leanback 和 Media3。进入 `tv/` 后运行 `.\gradlew.bat testDebugUnitTest lintRelease assembleRelease`。 |
| 两端播放规则 | 修改[规则参数](resources/rule-calibration.json)或[共享规则](src/shared/rules/)后，从仓库根目录运行 `node scripts/export-tv-vectors.mjs`，检查生成差异并运行两端测试。 |

构建安装包、签名与发布步骤见[发布说明](docs/ci-release.md)。历次版本的测试结果和设备记录见[交付报告](docs/delivery-report.md)。
