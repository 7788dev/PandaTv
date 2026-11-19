# Agent Note: 本机代理 DNS 与公网媒体连接

Status: implemented

## Problem

本机网络代理把 img3.doubanio.com 解析为 198.18.1.192。原媒体代理拒绝保留地址，真实首页所有海报返回 502。直接放行此地址段会削弱公网目的地址校验。另有小字体被 Vite 内联成 data URL，违反已有 font-src CSP。

## Decision

系统 DNS 返回全部 FakeIP 地址或解析失败时，主进程通过固定 HTTPS 公共解析器取得真实 A 记录，再验证并固定公网 IP 建立连接。系统返回 LAN 地址仍立即拒绝，HTTPS DNS 返回私网地址也拒绝。结果按 TTL 缓存最多 60 秒并合并重复查询；AliDNS 优先、Cloudflare 备用。渲染器继续只持有不透明 loopback 资源句柄。字体资源使用独立本地文件，保持 font-src 'self'。

## Alternatives considered

- 放行 198.18/15：无法区分真正测试网络与代理映射，会绕过目的地址边界。
- 改用不校验 DNS 的 fetch 请求全部媒体：无法保持现有重定向和连接目的地址校验。
- 仅用系统 resolve4：当前环境返回 ECONNREFUSED，无法完成真实连接。
- 要求用户关闭网络代理：会让默认运行依赖用户额外操作。
- 放宽字体 CSP 到 data：现有资源构建可以解决，无需增加允许来源。

## Consequences

新增域名解析可能请求两个固定公共 DNS 服务，失败仍暴露资源错误；不缓存凭据。修复前两项网络/元数据回归失败，修复后完整 53 项离线测试通过，真实应用加载 57 张海报且无 CSP 错误。证据见[回归前](../../../../docs/evidence/network-dns-before.txt)、[回归后](../../../../docs/evidence/network-dns-after.txt)和[实际启动](../../../../docs/evidence/runtime/startup-after.png)。
