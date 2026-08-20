# Windows 实现设计

## 1. Windows 端口发现

Rust 层直接调用 Windows IP Helper API，不通过解析 `netstat` 文本：

- `GetExtendedTcpTable`：IPv4/IPv6，`TCP_TABLE_OWNER_PID_ALL`；
- `GetExtendedUdpTable`：IPv4/IPv6，`UDP_TABLE_OWNER_PID`；
- TCP 仅把 `LISTEN` 作为可关注的服务候选；
- UDP 的每个绑定视为监听候选；
- 端口按网络字节序转换；
- 同次扫描按 PID 缓存进程信息。

进程信息使用 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` 和 `QueryFullProcessImageNameW`。PID 0、PID 4、受保护进程或权限不足时保留端口记录，进程名退化为 `PID <n>`，不能因为详情失败丢掉监听项。

实现时优先使用维护良好的 Rust Windows bindings，并将 `unsafe` 封装在小型 adapter 内。表缓冲区读取必须检查长度、行数和结构大小，避免相信系统返回的偏移而越界。

## 2. WSL 发现

### 2.1 发行版

通过直接启动进程（非 shell）执行 `wsl.exe --list --running --quiet`。清理 UTF-16/控制字符和空行，并为单次扫描设置超时。首版默认扫描已运行发行版；设置页可允许改用 `wsl.exe --list --quiet` 扫描全部发行版，但这可能启动休眠中的 WSL，必须明确提示。

### 2.2 监听端口

对每个发行版执行等价于：

```text
wsl.exe -d <distribution> -- sh -lc "ss -H -lntup"
```

这里的固定脚本由 Rust 常量提供，发行版名称作为独立进程参数传递，不拼入脚本文本。解析器需覆盖：

- IPv4、IPv6、`*`、`0.0.0.0`、`[::]`；
- TCP/UDP；
- 缺少进程详情的情况；
- BusyBox/iproute2 输出差异。

若发行版没有 `ss`，首版返回该发行版 warning，不以脆弱的 `/proc/net` 解析静默降级。Windows 发现结果仍正常返回。

### 2.3 WSL 地址

创建/修复转发时再解析目标 IP，而不是每次列表刷新都解析。可使用固定命令读取发行版网络接口地址，过滤 loopback、link-local，并优先选择默认路由接口中与内部绑定同地址族的地址。解析不到唯一可靠地址时返回 `WSL_ADDRESS_UNAVAILABLE`，禁止猜测。

WSL mirrored networking 等环境可能使 localhost 直连可用，但首版仍以实际探测和显式 adapter 结果为准，不根据 Windows/WSL 版本号猜行为。

## 3. PortProxy 管理

参考 `D:\github\tools\PortProxyGUI`，Portman 通过 Windows 注册表 API 读取和修改 PortProxy 规则，不解析本地化的 `netsh` 文本。四类规则分别位于：

```text
HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov4\tcp
HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v4tov6\tcp
HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v6tov4\tcp
HKLM\SYSTEM\CurrentControlSet\Services\PortProxy\v6tov6\tcp
```

注册表值名为 `<listen-address>/<listen-port>`，值数据为 `<connect-address>/<connect-port>`。读取可在普通权限下完成；新增、更新、删除以及通知 IP Helper 重新加载需要由提权 helper 执行。端口先解析为 `u16`，地址先解析为 `IpAddr`，代理类型必须属于固定枚举。

### 3.1 规则身份

Windows PortProxy 的唯一键是代理类型、监听地址与监听端口。删除时只允许删除与当前服务配置完全相同的键。执行删除前先读取实际规则：

- 若实际目标与 Portman 期望一致，可以删除；
- 若同一监听键指向其他目标，返回 `PORT_CONFLICT`，不删除第三方规则；
- 若规则不存在，禁用/删除可视为幂等成功，但记录 warning。

### 3.2 读取、写入和重新加载

读取四个键下的所有值，逐项解析地址和端口。错误值不导致应用崩溃，应形成 warning 并保留其原始键名用于诊断。系统规则读取失败时转发状态为 `error`，不能根据配置直接显示 active。

写入或删除成功后，通过 Service Control Manager 向 `iphlpsvc` 发送 `SERVICE_CONTROL_PARAMCHANGE`，使规则及时重新加载。通知失败视为操作失败并进入复核/补偿流程，不能只因注册表写入成功就报告完成。

另外读取 Windows TCP 监听表用于冲突检测。若外部端口已被普通进程监听，即使 PortProxy 注册表没有同键规则，也返回冲突。

### 3.3 生效复核

变更命令成功不等于功能可用。复核至少包括：

1. 四类注册表规则中存在/不存在目标规则；
2. 新增/启用后，Windows TCP 表出现外部监听；
3. 若内部服务当前运行，可做短超时 TCP connect 探测；探测失败作为 warning，因为应用层服务可能立即断开，但不能把它当作规则缺失。

## 4. WSL IP 漂移

每次快照对期望启用的 WSL 转发做只读比较：

- 规则目标 IP 等于当前可靠解析出的 WSL IP：正常；
- 不相等：`repair_required`；
- WSL 停止、无法解析 IP：保留规则信息，显示服务停止，不自动弹 UAC；
- 用户点击“修复”后，提权助手先安全删除旧的同属规则，再创建新目标并复核。

Portman 启动时不自动修改全局网络配置，避免每次开机或 WSL 重启都出现意外 UAC。

## 5. 防火墙和 IP Helper 服务

PortProxy 生效依赖 `IP Helper (iphlpsvc)`，且局域网访问可能被防火墙阻断。快照读取服务状态；若服务未运行，所有期望启用的转发显示错误并提供“启动 IP Helper”操作。只有用户确认后才按需提权启动服务，不在应用启动时静默操作；用户在此状态下执行“启用转发”时，可以在一次确认和一次 UAC 中组合“启动服务、写入规则、通知重载”。诊断中区分：

- 规则不存在；
- 外部监听不存在；
- 本机连接失败；
- 本机正常但可能受防火墙限制。

首版不自动启动系统服务，也不创建/删除防火墙规则。设置为 `0.0.0.0` 时展示可复制的诊断建议，但不提供任意 PowerShell 执行入口。

## 6. 配置路径与原子写入

使用 Windows 用户配置文件目录拼接 `.portman\config.yaml`，目录不存在时创建。写入流程：

1. 在同目录创建随机临时文件；
2. 写入完整 YAML 并 flush；
3. 对已有配置生成/更新 `.bak`；
4. 使用同卷原子替换；
5. 重新读取并校验结果。

敏感操作前再次从磁盘读取配置，避免用户手工编辑后被进程内旧快照覆盖。可比较文件修改时间或内容哈希，发生并发修改时返回 `CONFIG_CHANGED`。

## 7. 与参考项目的关系

### 7.1 PortCheck：界面参考

- 参考端口列表的信息密度、搜索筛选、状态徽标和明暗主题表达；
- 参考部分扫描失败时保留已有数据和 warning 的体验；
- 不采用其任务管理器业务，也不把结束进程带入 Portman。

`PortCheck` 仅用于视觉和交互评审，不作为 Portman 功能范围或后端实现的参考来源。

### 7.2 PortProxyGUI：功能参考

- 参考四种代理类型与“监听键唯一”的规则模型；
- 参考直接读写 PortProxy 注册表，避免解析 `netsh` 本地化输出；
- 参考禁用时删除系统规则、但保留应用配置的语义；
- 参考检测/启动 IP Helper，以及写入后发送 `SERVICE_CONTROL_PARAMCHANGE`；
- 参考规则备注和分组的思路，其中 Portman 以服务名称和后续标签承载。

Portman 不照搬其全程管理员运行和 SQLite 配置方式：主进程使用普通权限、写操作按需 UAC，配置使用用户要求的 YAML。Portman 也不自动把所有外部系统规则导入关注列表；未托管规则仅参与冲突检测，避免无意接管第三方配置。
