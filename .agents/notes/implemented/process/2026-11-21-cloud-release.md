# Agent Note: GitHub 托管构建与标签发布

Status: implemented

## Problem

2026-11-21 检查 `7788dev/PandaTv`：Actions 已启用，但工作流、Release 和 Actions secrets 数量均为 0。Windows NSIS 和 TV 签名 APK 只能在开发电脑上构建；本机 npm / Maven / Gradle 镜像和签名文件不能直接当成云端环境。

## Decision

[CI](../../../../.github/workflows/ci.yml)在默认分支推送和 PR 时调用[同一份构建](../../../../.github/workflows/build.yml)。Windows 生成 NSIS，Ubuntu 生成 TV APK。手动 CI 可启用原密钥签名，不创建 Release；自动 CI 的 TV 包明确标为 unsigned。版本、SDK 与 Gradle 从源码读取。

[Release](../../../../.github/workflows/release.yml)由 `v<桌面版本>` 标签触发，也可选择已有标签手动重跑。两个客户端保留独立版本。通过同一构建门槛后，发布任务仅接收两个已构建的包并生成校验清单，先草稿上传、成功后公开。只有发布任务拥有 `contents: write`，electron-builder 使用 `--publish never`，已公开的 Release 不自动覆盖。

TV 只使用既有发行密钥，通过 Actions secrets 传入；校验证书 SHA256 和 v1/v2 双签名。CI 的 registry 调整只发生在 runner，保留锁文件版本及 integrity，不改本机镜像。Actions 固定到已核对的 commit SHA。

操作入口、secret 定义与验证边界统一记录在[云端发布说明](../../../../docs/ci-release.md)，本次执行与激活状态见[验证记录](../../../../docs/evidence/ci-release.txt)。

## Alternatives considered

- 自托管 runner：仍需要用户电脑或专门常驻机器在线，不能解决这次的本机依赖。
- 只上传本机已有安装包：没有把编译搬到云端，后续版本仍要本机构建。
- electron-builder 自行发布桌面包，TV 另发：任一端失败时可能出现不完整 Release，因此统一在两个构建完成后发布。
- CI 使用调试签名或自动生成新签名：不能覆盖已安装 TV 发行版，故正式发布只接受原证书，PR 则保持无密钥的编译检查。
- 把所有真实片源 E2E 当作海外 runner 的发布门槛：第三方收录、地区和网络出口会导致不稳定；云端检查离线 UI / 规则，真实播放和设备验证仍独立记录。

## Consequences

工作流需要提交并推送才会在 GitHub 生效；本地存在 YAML 不代表云端已成功。TV 签名 secret 必须完整配置，缺失时发布失败，不回退到 unsigned。安装包可从 Actions 下载，正式版可从 Releases 下载；自动更新服务与 Windows 代码签名仍是独立事项。

Windows 干净检出会按 `core.autocrlf` 转换换行，破坏清单逐行比较和冻结设计的字节摘要。首次托管 CI 因此有 21 项播放测试失败；同样的干净检出还独立复现了设计检查失败。[根属性](../../../../.gitattributes)固定 `docs/evidence/manifest-*.m3u8` 的 LF 并禁止转换 `design/` 的文件，使两项检查跨平台一致，保留生产解析行为及原始文件内容。
