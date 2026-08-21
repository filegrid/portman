# Portman

[English](./README.md) | 简体中文

Portman 是一个面向 Windows 的桌面端口管理工具，用于查看和关注 Windows/WSL 监听端口，并检查、创建和管理 Windows PortProxy 映射。

## 当前能力

- 扫描 Windows TCP/UDP 监听端口、进程和可执行文件路径；
- 扫描正在运行的 WSL 发行版监听端口；
- 按端口号合并 IPv4/IPv6、WSL 与 `wslrelay.exe` 绑定；
- 默认隐藏 UDP 和 Windows 系统服务，可通过筛选项显示；
- 根据 Windows 当前实际 PortProxy 规则展示外部端点与转发状态；
- 标记直接绑定非回环地址或通过外部映射暴露的服务；
- 新增、启用、禁用和删除由 Portman 管理的 PortProxy 转发；
- 默认使用 `v4tov4` 和 `127.0.0.1`，其他代理类型与地址位于高级选项；
- 右键菜单可打开 Windows 进程可执行文件所在目录；
- 支持英文与简体中文切换，默认使用英文；
- 配置保存到 `%USERPROFILE%\.portman\config.yaml`。

## 运行

发布版 `portman.exe` 可以独立运行，不需要 Node.js、pnpm 或 Rust。目标系统需要 Microsoft Edge WebView2 Runtime；Windows 10/11 通常已经安装。

查看端口通常不需要管理员权限。修改 Windows PortProxy 规则时，程序会按需请求 UAC 权限。WSL 扫描要求系统已安装 WSL。

## 开发环境

- Windows 10/11
- Node.js 20+
- pnpm 10+
- Rust stable
- Tauri 2 所需的 WebView2 与 MSVC 构建工具

```powershell
pnpm install
pnpm tauri dev
```

前端生产构建：

```powershell
pnpm build
```

Rust 测试：

```powershell
cd src-tauri
cargo test
```

生成独立 release 可执行文件：

```powershell
cd src-tauri
cargo build --release
```

输出文件为 `src-tauri/target/release/portman.exe`。

设计文档见 [docs/design/README.md](./docs/design/README.md)。
