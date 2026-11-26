# GitHub 云端构建与发布

仓库为 `7788dev/PandaTv`。工作流使用 GitHub 托管的 Windows / Ubuntu 机器，无需开发电脑在线。配置提交并推送到默认分支后生效。

## 平时提交

推送 `master` 或提交 Pull Request 自动运行 [CI](../.github/workflows/ci.yml)，复用同一份[构建流程](../.github/workflows/build.yml)：

- Windows 使用 Node 24，依次检查锁文件安装、TypeScript、规则参数、单元测试和发布脚本，构建 NSIS x64 安装包并核验 asar。随后用 FFmpeg 生成音视频素材，在编译后的 Electron 应用中运行离线交互和布局测试。
- TV：JDK 21、从项目读取的 Gradle / Android SDK 版本、双端黄金向量一致性、单测、兼容性 lint、release APK。保持 `minSdk = 22`。
- 成功的安装包上传到该次 Actions 运行的 Artifacts，保留 14 天；失败的测试报告保留 7 天。自动 CI 的 TV 包标为 `-unsigned.apk`，仅供编译检查，不能作为正常安装包使用。

云端安装依赖使用官方 npm、Google Maven、Maven Central 与 Gradle 分发服务。只在临时 runner 上调整镜像地址，不修改仓库的本机镜像配置；npm 版本和 integrity 校验值沿用锁文件。

## 手动获取可安装的新包

GitHub → Actions → **CI** → **Run workflow**，选择分支，保留 **signed-tv** 勾选。成功后下载 `windows-dist` 和 `tv-dist`。这个操作生成 Windows 安装程序和使用既有签名的 TV APK，不会创建 Release，也不会修改版本号。

等价命令（在已有新代码的分支上）：

```powershell
gh workflow run ci.yml --ref master -f signed-tv=true
gh run list --workflow ci.yml
gh run watch <run-id> --exit-status
gh run download <run-id> --dir release/cloud
```

## 正式发版

接入时仓库已有 `v1.1.0`、`v1.1.2` 标签，但这些提交没有工作流。保留历史标签，首次自动发布使用接入工作流后的新版本标签；当前分支仍可通过手动 CI 打出可安装的包。

1. 修改根 `package.json` 及 `package-lock.json` 的桌面版本；若更新 TV，同时递增 `tv/app/build.gradle.kts` 的 `versionName` 和 `versionCode`。两个客户端版本独立，发布标签跟随桌面版本。
2. 提交、推送代码，等待该提交的 CI 通过。
3. 为已验收的提交创建并推送与新桌面版本对应的标签。

   ```powershell
   $releaseVersion = node -p "require('./package.json').version"
   git tag -a "v$releaseVersion" -m "Panda $releaseVersion"
   if ($LASTEXITCODE -eq 0) { git push origin "v$releaseVersion" }
   ```

4. [Release 工作流](../.github/workflows/release.yml)重新执行全部云端检查和构建，验证 TV v1/v2 签名及现有证书指纹，生成 `SHA256SUMS.txt`，再创建 GitHub Release。

Release 附件为 `Panda-<桌面版本>-Setup.exe`、`Panda-TV-<TV版本>.apk` 和 `SHA256SUMS.txt`。标签与源码版本不符、任一构建/检查失败、缺少签名密钥、证书不同、缺少附件时，均不能发布。先上传到草稿、全部上传成功后公开，避免用户看到半套安装包；已公开的版本不自动覆盖。

失败时先修正外部配置或网络问题，在 Actions 重跑该次失败任务。也可以选择已有版本标签手动运行 **Release**：

```powershell
gh workflow run release.yml --ref v1.1.4
```

手动 Release 必须选择版本标签，选分支会失败。若修复需要改变源码，使用新版本和新标签，不移动已发布标签。

## TV 签名

在仓库 **Settings → Secrets and variables → Actions** 配置以下四个 repository secrets；不得把值写入源码、日志、Issue 或附件：

| Secret | 内容 |
| --- | --- |
| `TV_KEYSTORE_BASE64` | 现有 `tv/.keystore/release.jks` 的完整 Base64 |
| `TV_STORE_PASSWORD` | 原 keystore 的 storePassword |
| `TV_KEY_ALIAS` | 原 keyAlias |
| `TV_KEY_PASSWORD` | 原 keyPassword |

必须复用原密钥。工作流核对既有证书 SHA256 `d49e8eaee47712b2dac54444ef627d53fd2bf302ddc67ecdcbd3d8d695073fcd`，以保持覆盖升级能力；不生成新的发行密钥。签名配置只存在于本次 runner，结束时清理，不上传到 artifact。普通自动 CI 不使用签名密钥，外部 fork PR 也不需要 secret。

桌面 NSIS 安装程序目前未做代码签名。两端设置的“检查更新”默认读取公开的稳定 Release，分别识别已上传的 Windows 安装程序和 TV APK。查看发布页后由用户选择下载安装。桌面部署也可用 `PANDA_UPDATE_URL` 指定自有 HTTPS 版本清单。

## 验证边界

云端 CI 的 Electron 回归使用离线 fixture 检查 UI、布局与本地媒体控制。真实上游回放在本地运行 `npm run test:e2e`。TV 导航、焦点和播放分别用[导航脚本](../scripts/verify-tv-navigation.py)、[动效脚本](../scripts/verify-tv-motion.py)和[播放切换脚本](../scripts/verify-tv-playback-transitions.py)在已安装应用的设备上核验。设备、系统版本和 APK 摘要随结果记录。

播放切换脚本启动时读取设备防火墙规则和应用私有状态，完整回放需要具备相应权限的测试模拟器。普通 ADB 设备可用遥控器操作应用，验证切集、暂停和退出后的续播入口。

本地验证工作流语法可用 `actionlint`；发布脚本测试为 `npm run test:release`。完整验证记录见 [CI 接入证据](evidence/ci-release.txt)。
