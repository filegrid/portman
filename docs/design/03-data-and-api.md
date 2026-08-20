# 数据模型与 Tauri 接口

## 1. YAML 配置

文件位置固定为 `%USERPROFILE%\.portman\config.yaml`。不要依赖进程当前工作目录，也不要使用 Tauri 默认 AppData 目录代替该业务要求。

```yaml
version: 1
settings:
  default_external_address: 127.0.0.1

services:
  - id: 01J5YQ8M7A3E9VQ2T5ZK6P4R1C
    name: Web Admin
    category: windows
    bindings:
      - { protocol: tcp, address: 127.0.0.1, port: 5173 }
      - { protocol: tcp, address: 0.0.0.0, port: 4173 }
    identity:
      process_path: C:\work\web\node.exe
      process_name: node.exe
    forwarding:
      proxy_type: v4tov4
      listen_address: 127.0.0.1
      external_port: 15173
      target_address: 127.0.0.1
      target_port: 5173
      enabled: true

  - id: 01J5YR2KQD4P3MSB8E3D5R9K2X
    name: API in Ubuntu
    category: wsl
    bindings:
      - { protocol: tcp, address: 0.0.0.0, port: 8080 }
    identity:
      distribution: Ubuntu-24.04
      process_name: api-server
    forwarding:
      proxy_type: v4tov4
      listen_address: 0.0.0.0
      external_port: 18080
      target_address: 0.0.0.0
      target_port: 8080
      enabled: false
```

### 1.1 配置约束

- `version` 必填；高于当前支持版本时拒绝写入。
- `id` 使用 ULID 或 UUID，创建后不变。
- 名称去除首尾空白，长度 1–80，同一配置中允许同名但 UI 提示。
- 端口范围为 1–65535。
- 每个服务至少有一个绑定；协议为 `tcp | udp`。转发目标必须选择该服务的一个 TCP 绑定。
- Windows `process_path` 可缺省；有值时做大小写不敏感、分隔符规范化比较。
- WSL `distribution` 必填，必须与 `wsl.exe --list --quiet` 的精确名称对应。
- 首版 `listen_address` 接受 `127.0.0.1`、`0.0.0.0`、`::1`、`::`；具体网卡地址作为高级选项，必须是当前主机地址。
- `proxy_type` 默认为 `v4tov4`；`v4tov6 | v6tov4 | v6tov6` 通过高级选项设置。监听地址和目标地址族必须与类型一致。
- 同一 `listen_address + external_port` 在 Portman 配置中必须唯一；系统规则身份额外包含代理类型，但不同目标族不能共享同一实际监听端点。
- 不把 PID、WSL 当前 IP、最后状态、时间戳写入配置。

## 2. Rust 领域模型

```rust
struct TrackedService {
    id: ServiceId,
    name: String,
    category: ServiceCategory,
    bindings: Vec<ServiceBinding>,
    identity: ServiceIdentity,
    forwarding: Option<ForwardingConfig>,
}

enum ServiceCategory { Windows, Wsl }
enum Protocol { Tcp, Udp }
enum PortProxyType { V4ToV4, V4ToV6, V6ToV4, V6ToV6 }

enum ServiceIdentity {
    Windows { process_path: Option<PathBuf>, process_name: String },
    Wsl { distribution: String, process_name: Option<String> },
}

struct ForwardingConfig {
    proxy_type: PortProxyType,
    listen_address: IpAddr,
    external_port: u16,
    target_address: IpAddr,
    target_port: u16,
    connect_address: Option<IpAddr>,
    last_applied_connect_address: Option<IpAddr>,
    enabled: bool,
}
```

`connect_address` 是用户在高级选项中的显式覆盖；`last_applied_connect_address` 记录最近一次由 Portman 成功写入系统规则的目标，仅用于 WSL 停止/IP 漂移时的所有权校验与安全删除。

YAML 模型、领域模型和 API DTO 分开定义。反序列化后先校验，再转换为领域模型；不要让无效配置直接进入业务层。

## 3. 运行 DTO

```ts
type RuntimeState = 'running' | 'stopped' | 'conflict' | 'unknown'
type ForwardingState =
  | 'unconfigured'
  | 'disabled'
  | 'active'
  | 'repair_required'
  | 'conflict'
  | 'error'

interface DashboardSnapshot {
  generatedAt: string
  services: ServiceView[]
  system: { ipHelperState: 'running' | 'stopped' | 'unknown' }
  warnings: AppWarning[]
}

interface ServiceView {
  id: string
  name: string
  category: 'windows' | 'wsl'
  categoryDetail?: string
  bindings: Array<EndpointView & { protocol: 'tcp' | 'udp'; active: boolean }>
  actualForwardings: ActualForwardingView[]
  external?: EndpointView
  runtimeState: RuntimeState
  forwardingState: ForwardingState
  process?: { pid?: number; name?: string; path?: string }
  diagnostics: Diagnostic[]
  capabilities: {
    canCreateForwarding: boolean
    canEnableForwarding: boolean
    canDisableForwarding: boolean
    canDeleteForwarding: boolean
  }
}
```

`capabilities` 由后端计算，前端不自行推导。例如 UDP 或扫描状态未知时，后端可以直接禁止新增转发并给出诊断。

`actualForwardings` 每次从 Windows 当前 PortProxy 规则生成，是列表“外部端点”和“转发状态”的事实来源。`forwarding` 仅表示 Portman 配置的期望状态；配置存在但系统规则缺失时显示待修复，系统存在未托管规则时仍按实际规则显示为已生效。

## 4. Tauri commands

命令统一返回结构化错误：`{ code, message, details?, operationId? }`。`message` 可用于兜底展示，但 UI 分支只依赖稳定 `code`。

| Command | 请求 | 返回 | 说明 |
| --- | --- | --- | --- |
| `get_dashboard_snapshot` | 无 | `DashboardSnapshot` | 获取一致性快照 |
| `discover_candidates` | 无 | `DiscoveryResult` | 返回未关注候选及 warning |
| `create_service` | `{ candidateTokens, name }` | `OperationResult` | 二次验证同一来源的全部绑定并创建关注项 |
| `remove_service` | `{ serviceId }` | `OperationResult` | 清理托管转发后取消关注 |
| `create_forwarding` | `{ serviceId, listenAddress, externalPort, targetAddress, targetPort, enabled }` | `OperationResult` | 从服务 TCP 绑定选择目标，可创建为禁用 |
| `set_forwarding_enabled` | `{ serviceId, enabled }` | `OperationResult` | 应用或移除系统规则 |
| `repair_forwarding` | `{ serviceId }` | `OperationResult` | 按当前目标重建规则 |
| `delete_forwarding` | `{ serviceId }` | `OperationResult` | 清理规则并删除配置 |
| `get_settings` | 无 | `SettingsView` | 获取设置 |
| `update_settings` | `SettingsPatch` | `SettingsView` | 校验后更新设置 |
| `start_ip_helper_service` | 无 | `OperationResult` | 用户确认后按需提权启动 `iphlpsvc` |
| `open_config_directory` | 无 | `OperationResult` | 用户显式操作时打开目录 |

不提供通用的 `run_command`、`run_powershell`、注册表写入或服务控制接口。

## 5. 候选模型与去重

候选按运行环境和端口号合并；协议不参与分组与主排序：

```text
windows:<port>
wsl:<distribution>:<port>
```

地址规范化规则：

- IPv4/IPv6 使用解析后的标准表示；
- `*` 统一为 `0.0.0.0` 或 `::`；
- Windows 路径大小写不敏感；
- WSL 发行版名称保持原值，但比较时按 Windows 命令输出的精确名称；
- PID 不参与去重。

一次扫描中的 `candidateToken` 是随机不可预测值，后端缓存其对应候选及过期时间。前端不能伪造路径、发行版或内部端口来绕过“从当前监听项创建”的约束。

## 6. 转发目标解析

| 来源绑定 | `connectaddress` | 代理目标族 |
| --- | --- | --- |
| Windows `127.0.0.1` | `127.0.0.1` | IPv4 |
| Windows `0.0.0.0` | `127.0.0.1` | IPv4 |
| Windows 具体 IPv4 | 原地址 | IPv4 |
| Windows `::1` / `::` | `::1` | IPv6 |
| Windows 具体 IPv6 | 原地址 | IPv6 |
| WSL IPv4 通配/具体地址 | 当前发行版默认路由接口的 IPv4 | IPv4 |
| WSL IPv6 通配/具体地址 | 当前发行版可靠的 IPv6 | IPv6 |

监听地址族与上表目标地址族共同决定四种代理类型。系统实际规则中保存的是解析后的 WSL IP，配置中保存的是发行版身份。这样 WSL IP 改变时能检测漂移，并通过 `repair_forwarding` 重建，而不是把短生命周期 IP 固化为业务配置。
