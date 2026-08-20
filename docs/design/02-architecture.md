# 系统架构设计

## 1. 总体结构

```text
React UI
  ├─ pages/components
  ├─ query/state layer
  └─ typed Tauri command client
             │ invoke / event
Tauri application (Rust)
  ├─ commands          输入校验与 DTO 转换
  ├─ application       用例编排、事务/回滚、状态聚合
  ├─ domain            Service、Forwarding、状态规则
  └─ infrastructure
      ├─ config        YAML 仓储与原子写入
      ├─ windows       端口表、进程信息、PortProxy 注册表、服务控制、UAC
      └─ wsl           发行版、监听端口、IP 解析
```

React 不直接访问注册表、Windows 服务控制接口，也不执行 PowerShell 或 `wsl.exe`，并且不持有系统状态判定逻辑。所有系统调用和外部命令参数必须由 Rust 构造，禁止把前端传入的自由文本拼接为 shell 命令。

## 2. 推荐目录

```text
portman/
├─ package.json
├─ pnpm-lock.yaml
├─ src/
│  ├─ app/
│  ├─ pages/services/
│  ├─ pages/settings/
│  ├─ components/
│  ├─ hooks/
│  ├─ lib/tauri.ts
│  └─ types/api.ts
├─ src-tauri/
│  ├─ Cargo.toml
│  └─ src/
│     ├─ main.rs
│     ├─ lib.rs
│     ├─ commands/
│     ├─ application/
│     ├─ domain/
│     └─ infrastructure/
│        ├─ config/
│        ├─ windows/
│        └─ wsl/
└─ docs/design/
```

Windows 专用代码使用 `#[cfg(target_os = "windows")]` 隔离。领域模型不依赖 Win32 类型，为后续平台扩展保留边界，但首版不为未实现的平台制造空壳功能。

## 3. 后端组件职责

### 3.1 DiscoveryService

- 并行扫描 Windows 和各个可用 WSL 发行版；
- 生成规范化的 `DiscoveredEndpoint`；
- 合并重复绑定并附带 warning；
- 为候选生成只在本次扫描有效的 token；
- 根据配置计算当前运行状态。

DiscoveryService 维护一个短期内存缓存，候选 token 建议 30 秒过期。创建关注项时根据 token 取回候选并重新扫描目标，防止 TOCTOU 问题。

### 3.2 ServiceRepository

- 读取、校验和迁移 `config.yaml`；
- 序列化配置，不存储运行快照；
- 在单进程写锁内执行原子替换；
- 写入前创建 `config.yaml.bak`；
- 配置非法时返回错误，不自动覆盖用户文件。

### 3.3 ForwardingService

- 校验转发能力和参数；
- 从内部端点解析可连接目标；
- 检测系统监听与现有 PortProxy 注册表规则冲突；
- 调用提权助手执行精确的新增/删除操作；
- 重新读取规则并生成实际状态；
- 编排系统操作与配置写入之间的补偿事务。

### 3.4 SnapshotService

一次刷新组装一个完整 `DashboardSnapshot`：配置服务、发现结果、系统转发规则、warning 和时间戳。前端只消费这一份一致性快照，避免分别调用多个接口造成状态交叉。

## 4. 并发与生命周期

- `AppState` 持有只读配置快照、刷新互斥锁、候选缓存和操作互斥锁。
- 刷新可以并发执行 Windows 与 WSL 子扫描，但同类扫描设置上限，避免同时启动过多 `wsl.exe`。
- 所有配置/转发变更串行化；在一个系统变更完成前拒绝第二个变更并返回 `OPERATION_IN_PROGRESS`。
- 应用启动只做只读扫描，不静默弹 UAC，不自动修改系统规则或启动系统服务。
- 应用退出不删除转发；转发属于持久系统配置，由用户显式管理。

## 5. 权限模型

应用主进程始终以普通用户运行。读取端口、进程信息、PortProxy 注册表项和 IP Helper 状态尽量使用只读低权限 API。需要管理员权限的规则写入、服务启动和参数变更通知采用“同一可执行文件的提权助手模式”：

1. 主进程生成带随机 nonce 的请求文件，限制当前用户访问；
2. 通过 Windows `runas` 启动当前可执行文件的 `--elevated-helper` 模式；
3. helper 只接受枚举化操作及严格结构化参数；
4. helper 执行一条精确系统操作，写入结构化结果后退出；
5. 主进程验证 nonce、操作和结果，删除临时文件并复核系统状态。

helper 不启动 WebView，不接受任意命令行，不执行前端传入脚本。取消 UAC 是正常业务结果 `ELEVATION_CANCELLED`，不作为崩溃处理。

## 6. 配置事务

系统 PortProxy 注册表与 YAML 无法形成真正的原子事务，采用可补偿流程：

### 新增/启用

1. 读取并校验最新配置；
2. 做只读预检；
3. 提权应用系统规则；
4. 复核系统规则；
5. 原子写配置；
6. 第 5 步失败时删除刚创建的规则并报告是否回滚成功。

### 禁用/删除

1. 读取并校验最新配置；
2. 提权删除系统规则；
3. 复核规则不存在；
4. 原子更新配置；
5. 第 4 步失败时尝试恢复原规则。

任何补偿失败都返回 `ROLLBACK_FAILED`，保留足够诊断信息，并在下一次快照中显示实际系统状态。

## 7. 可观测性

日志写入 `%USERPROFILE%\.portman\logs\portman.log`，按大小轮转并默认保留 7 份。日志包含操作 ID、服务 ID、错误码和耗时，但不记录完整环境变量或无关命令输出。设置页提供“复制诊断信息”，内容需对用户名路径做可选脱敏。
