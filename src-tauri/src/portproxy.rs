use crate::models::{ApiError, PortProxyType};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;
use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WRITE};
use winreg::RegKey;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortProxyRule {
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub listen_port: u16,
    pub connect_address: String,
    pub connect_port: u16,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum HelperAction {
    AddRule,
    DeleteRule,
    StartIpHelper,
}

#[derive(Debug, Serialize, Deserialize)]
struct HelperRequest {
    action: HelperAction,
    rule: Option<PortProxyRule>,
    response_path: PathBuf,
}

#[derive(Debug, Serialize, Deserialize)]
struct HelperResponse {
    ok: bool,
    message: String,
}

pub fn read_rules() -> Result<Vec<PortProxyRule>, ApiError> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let mut result = Vec::new();
    for proxy_type in [
        PortProxyType::V4ToV4,
        PortProxyType::V4ToV6,
        PortProxyType::V6ToV4,
        PortProxyType::V6ToV6,
    ] {
        let path = registry_path(proxy_type);
        let key = match hklm.open_subkey_with_flags(&path, KEY_READ) {
            Ok(key) => key,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                return Err(ApiError::new(
                    "PORTPROXY_READ_FAILED",
                    format!("读取 {path} 失败：{error}"),
                ))
            }
        };
        for value in key.enum_values() {
            let (name, _) = match value {
                Ok(value) => value,
                Err(_) => continue,
            };
            let data: String = match key.get_value(&name) {
                Ok(value) => value,
                Err(_) => continue,
            };
            let Some((listen_address, listen_port)) = parse_rule_endpoint(&name) else {
                continue;
            };
            let Some((connect_address, connect_port)) = parse_rule_endpoint(&data) else {
                continue;
            };
            result.push(PortProxyRule {
                proxy_type,
                listen_address,
                listen_port,
                connect_address,
                connect_port,
            });
        }
    }
    Ok(result)
}

pub fn ip_helper_state() -> String {
    let output = hidden_command("sc.exe")
        .args(["query", "iphlpsvc"])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return "unknown".into();
    };
    if !output.status.success() {
        return "unknown".into();
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if text.lines().any(|line| {
        let compact = line.split_whitespace().collect::<Vec<_>>();
        compact
            .windows(2)
            .any(|pair| pair[0] == ":" && pair[1] == "4")
            || line.contains("RUNNING")
    }) {
        "running".into()
    } else {
        "stopped".into()
    }
}

pub fn add_rule(rule: PortProxyRule) -> Result<(), ApiError> {
    run_elevated(HelperAction::AddRule, Some(rule))
}

pub fn delete_rule(rule: PortProxyRule) -> Result<(), ApiError> {
    run_elevated(HelperAction::DeleteRule, Some(rule))
}

pub fn start_ip_helper() -> Result<(), ApiError> {
    run_elevated(HelperAction::StartIpHelper, None)
}

fn run_elevated(action: HelperAction, rule: Option<PortProxyRule>) -> Result<(), ApiError> {
    let temp_dir = std::env::temp_dir();
    let token = Uuid::new_v4();
    let request_path = temp_dir.join(format!("portman-{token}.request.json"));
    let response_path = temp_dir.join(format!("portman-{token}.response.json"));
    let request = HelperRequest {
        action,
        rule,
        response_path: response_path.clone(),
    };
    let bytes = serde_json::to_vec(&request)
        .map_err(|e| ApiError::new("ELEVATION_FAILED", format!("创建提权请求失败：{e}")))?;
    fs::write(&request_path, bytes)
        .map_err(|e| ApiError::new("ELEVATION_FAILED", format!("写入提权请求失败：{e}")))?;

    let executable = std::env::current_exe()
        .map_err(|e| ApiError::new("ELEVATION_FAILED", format!("定位应用程序失败：{e}")))?;
    let script = r#"param([string]$ExePath,[string]$RequestPath)
try {
  $quotedRequest = '"' + $RequestPath.Replace('"','\"') + '"'
  $process = Start-Process -FilePath $ExePath -ArgumentList @('--portman-helper', $quotedRequest) -Verb RunAs -Wait -PassThru -WindowStyle Hidden
  exit $process.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1223
}"#;
    let output = hidden_command("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
            "-ExePath",
            &executable.to_string_lossy(),
            "-RequestPath",
            &request_path.to_string_lossy(),
        ])
        .stdin(Stdio::null())
        .output();

    let _ = fs::remove_file(&request_path);
    let output =
        output.map_err(|e| ApiError::new("ELEVATION_FAILED", format!("启动提权助手失败：{e}")))?;
    if !output.status.success() && !response_path.exists() {
        return Err(ApiError::new(
            "ELEVATION_CANCELLED",
            format!(
                "管理员授权被取消或提权失败：{}",
                String::from_utf8_lossy(&output.stderr).trim()
            ),
        ));
    }

    let response_bytes = fs::read(&response_path)
        .map_err(|e| ApiError::new("ELEVATION_FAILED", format!("读取提权结果失败：{e}")))?;
    let _ = fs::remove_file(&response_path);
    let response: HelperResponse = serde_json::from_slice(&response_bytes)
        .map_err(|e| ApiError::new("ELEVATION_FAILED", format!("解析提权结果失败：{e}")))?;
    if response.ok {
        Ok(())
    } else {
        Err(ApiError::new("PORTPROXY_APPLY_FAILED", response.message))
    }
}

pub fn run_elevated_helper_if_requested() -> bool {
    let mut args = std::env::args_os();
    let _ = args.next();
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--portman-helper")) {
        return false;
    }
    let Some(request_path) = args.next() else {
        return true;
    };
    let request_path = PathBuf::from(request_path);
    let request = fs::read(&request_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<HelperRequest>(&bytes).ok());
    let Some(request) = request else {
        return true;
    };
    let result = execute_helper(&request);
    let response = match result {
        Ok(message) => HelperResponse { ok: true, message },
        Err(message) => HelperResponse { ok: false, message },
    };
    if let Ok(bytes) = serde_json::to_vec(&response) {
        let _ = fs::write(&request.response_path, bytes);
    }
    true
}

fn execute_helper(request: &HelperRequest) -> Result<String, String> {
    match request.action {
        HelperAction::StartIpHelper => {
            ensure_ip_helper_running()?;
            Ok("IP Helper 已启动".into())
        }
        HelperAction::AddRule => {
            let rule = request.rule.as_ref().ok_or("提权请求缺少规则")?;
            validate_rule(rule)?;
            ensure_ip_helper_running()?;
            write_rule(rule)?;
            notify_ip_helper()?;
            Ok("端口转发已启用".into())
        }
        HelperAction::DeleteRule => {
            let rule = request.rule.as_ref().ok_or("提权请求缺少规则")?;
            validate_rule(rule)?;
            delete_rule_direct(rule)?;
            if ip_helper_state() == "running" {
                notify_ip_helper()?;
            }
            Ok("端口转发已禁用".into())
        }
    }
}

fn write_rule(rule: &PortProxyRule) -> Result<(), String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let path = registry_path(rule.proxy_type);
    let (key, _) = hklm
        .create_subkey(&path)
        .map_err(|e| format!("打开 PortProxy 注册表失败：{e}"))?;
    let name = rule_name(rule);
    if let Ok(existing) = key.get_value::<String, _>(&name) {
        if existing != rule_value(rule) {
            return Err(format!("监听端点 {name} 已由其他转发规则占用"));
        }
    }
    key.set_value(name, &rule_value(rule))
        .map_err(|e| format!("写入 PortProxy 注册表失败：{e}"))
}

fn delete_rule_direct(rule: &PortProxyRule) -> Result<(), String> {
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let path = registry_path(rule.proxy_type);
    let key = match hklm.open_subkey_with_flags(&path, KEY_READ | KEY_WRITE) {
        Ok(key) => key,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("打开 PortProxy 注册表失败：{error}")),
    };
    let name = rule_name(rule);
    match key.get_value::<String, _>(&name) {
        Ok(existing) if existing != rule_value(rule) => {
            return Err(format!("监听端点 {name} 已指向其他目标，拒绝删除"))
        }
        _ => {}
    }
    match key.delete_value(&name) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除 PortProxy 规则失败：{error}")),
    }
}

fn ensure_ip_helper_running() -> Result<(), String> {
    if ip_helper_state() == "running" {
        return Ok(());
    }
    let output = hidden_command("sc.exe")
        .args(["start", "iphlpsvc"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("启动 IP Helper 失败：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "启动 IP Helper 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    for _ in 0..20 {
        if ip_helper_state() == "running" {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    Err("IP Helper 未在预期时间内启动".into())
}

fn notify_ip_helper() -> Result<(), String> {
    let output = hidden_command("sc.exe")
        .args(["control", "iphlpsvc", "paramchange"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("通知 IP Helper 失败：{e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "通知 IP Helper 重新加载失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn validate_rule(rule: &PortProxyRule) -> Result<(), String> {
    let listen = rule
        .listen_address
        .parse::<std::net::IpAddr>()
        .map_err(|_| "监听地址无效".to_string())?;
    let connect = rule
        .connect_address
        .parse::<std::net::IpAddr>()
        .map_err(|_| "目标地址无效".to_string())?;
    if listen.is_ipv6() != rule.proxy_type.listens_ipv6()
        || connect.is_ipv6() != rule.proxy_type.connects_ipv6()
    {
        return Err("代理类型与地址族不一致".into());
    }
    Ok(())
}

fn hidden_command(program: &str) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn registry_path(proxy_type: PortProxyType) -> String {
    format!(
        r"SYSTEM\CurrentControlSet\Services\PortProxy\{}\tcp",
        proxy_type.as_str()
    )
}

fn rule_name(rule: &PortProxyRule) -> String {
    format!("{}/{}", rule.listen_address, rule.listen_port)
}

fn rule_value(rule: &PortProxyRule) -> String {
    format!("{}/{}", rule.connect_address, rule.connect_port)
}

fn parse_rule_endpoint(value: &str) -> Option<(String, u16)> {
    let (address, port) = value.rsplit_once('/')?;
    Some((address.to_string(), port.parse().ok()?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_registry_endpoint() {
        assert_eq!(
            parse_rule_endpoint("127.0.0.1/8080"),
            Some(("127.0.0.1".into(), 8080))
        );
        assert_eq!(parse_rule_endpoint("::1/8080"), Some(("::1".into(), 8080)));
    }

    #[cfg(windows)]
    #[test]
    fn reads_live_portproxy_registry() {
        read_rules().expect("PortProxy registry should be readable without elevation");
        assert!(matches!(
            ip_helper_state().as_str(),
            "running" | "stopped" | "unknown"
        ));
    }
}
