# Agent Note: 安装包内容与可执行文件信息

Status: implemented

## Problem

首个 NSIS 安装包 152.5 MB，其中 app.asar 79.7 MB：electron-builder 默认把生产依赖的 `node_modules` 全部打进包，而 electron-vite 已把主进程、preload 和渲染器的依赖全部打进 `out/`（`externalizeDeps: false`），两份重复。同时 `win.signAndEditExecutable: false` 为了跳过签名连图标和版本信息的写入也一并关掉，安装后的 Panda.exe 没有产品名与版本。

## Decision

[package.json](../../../../package.json) 的 `build.files` 增加 `!node_modules/**/*`；`win.signExecutable: false` 只跳过签名（没有证书），保留图标与版本信息写入。结果：app.asar 13.9 MB、安装包 132.7 MB、Panda.exe 的 ProductName/FileVersion/CompanyName 正确；asar 内 268 项，无 node_modules、原型 mock/art/preview、测试、脚本或 source map。实际安装、安装版起播与卸载结果在 [install.txt](../../../../docs/evidence/install.txt)。

## Alternatives considered

- 保留 node_modules 并按包名逐个排除：依赖变化时名单会漏；当前没有任何运行时需要从 node_modules 加载的原生模块。
- 把依赖全部移到 devDependencies：能达到同样体积，但许可证清单脚本按生产依赖生成，分类会失真。
- 自签名证书：不被系统信任，SmartScreen 提示不变，还会让“已签名”看起来成立。

## Consequences

以后若引入必须在运行时从磁盘加载的依赖（原生模块、worker 文件），需要在 `build.files` 里显式放行。安装包未签名，首次运行会出现 SmartScreen 提示；自动更新没有发布服务，应用内明确反馈不可用。
