use crate::models::{AppWarning, DiscoveredEndpoint, Protocol, ServiceCategory};
use std::collections::HashMap;
#[cfg(windows)]
use std::os::windows::ffi::OsStringExt;
use std::process::{Command, Stdio};

pub fn discover_all(include_wsl: bool) -> (Vec<DiscoveredEndpoint>, Vec<AppWarning>) {
    let mut endpoints = Vec::new();
    let mut warnings = Vec::new();

    match discover_windows() {
        Ok(mut rows) => endpoints.append(&mut rows),
        Err(message) => warnings.push(AppWarning {
            code: "WINDOWS_DISCOVERY_FAILED".into(),
            message,
        }),
    }

    if include_wsl {
        let (mut wsl_rows, mut wsl_warnings) = discover_wsl();
        endpoints.append(&mut wsl_rows);
        warnings.append(&mut wsl_warnings);
    }

    endpoints.sort_by(|a, b| {
        a.port
            .cmp(&b.port)
            .then_with(|| category_rank(a.category).cmp(&category_rank(b.category)))
            .then_with(|| a.address.cmp(&b.address))
    });
    endpoints.dedup_by(|a, b| {
        a.category == b.category
            && a.category_detail == b.category_detail
            && a.protocol == b.protocol
            && a.address == b.address
            && a.port == b.port
            && a.process_path == b.process_path
    });
    (endpoints, warnings)
}

fn category_rank(category: ServiceCategory) -> u8 {
    match category {
        ServiceCategory::Windows => 0,
        ServiceCategory::Wsl => 1,
    }
}

fn discover_windows() -> Result<Vec<DiscoveredEndpoint>, String> {
    let output = hidden_command("netstat.exe")
        .args(["-ano"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法启动 netstat 后备扫描：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "netstat 后备扫描失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let process_names = tasklist_process_names();
    let mut process_paths = HashMap::<u32, Option<String>>::new();
    let text = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    for line in text.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        let Some(protocol_text) = fields.first().copied() else {
            continue;
        };
        let (protocol, local, pid_text) = if protocol_text.eq_ignore_ascii_case("TCP") {
            if fields.len() < 5 || !endpoint_has_zero_port(fields[2]) {
                continue;
            }
            (Protocol::Tcp, fields[1], fields[4])
        } else if protocol_text.eq_ignore_ascii_case("UDP") {
            if fields.len() < 4 {
                continue;
            }
            (Protocol::Udp, fields[1], fields[3])
        } else {
            continue;
        };
        let Some((address, port)) = parse_socket_address(local) else {
            continue;
        };
        let pid = pid_text.parse::<u32>().ok();
        let process_name = pid.and_then(|value| process_names.get(&value).cloned());
        let process_path = pid.and_then(|value| {
            process_paths
                .entry(value)
                .or_insert_with(|| query_process_path(value))
                .clone()
        });
        rows.push(DiscoveredEndpoint {
            candidate_token: String::new(),
            category: ServiceCategory::Windows,
            category_detail: process_name.clone(),
            protocol,
            address,
            port,
            pid,
            process_name,
            process_path,
            port_proxy_relations: Vec::new(),
        });
    }
    Ok(rows)
}

#[cfg(windows)]
fn query_process_path(pid: u32) -> Option<String> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return None;
    }
    let mut buffer = vec![0_u16; 32_768];
    let mut size = buffer.len() as u32;
    let ok = unsafe { QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size) };
    unsafe { CloseHandle(handle) };
    if ok == 0 || size == 0 {
        return None;
    }
    buffer.truncate(size as usize);
    Some(
        std::ffi::OsString::from_wide(&buffer)
            .to_string_lossy()
            .into_owned(),
    )
}

fn endpoint_has_zero_port(value: &str) -> bool {
    value
        .trim_end_matches(']')
        .rsplit_once(':')
        .is_some_and(|(_, port)| port == "0")
}

fn tasklist_process_names() -> HashMap<u32, String> {
    let output = hidden_command("tasklist.exe")
        .args(["/FO", "CSV", "/NH"])
        .stdin(Stdio::null())
        .output();
    let Ok(output) = output else {
        return HashMap::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim().trim_matches('"');
            let mut fields = line.split("\",\"");
            let name = fields.next()?.to_string();
            let pid = fields.next()?.parse::<u32>().ok()?;
            Some((pid, name))
        })
        .collect()
}

fn discover_wsl() -> (Vec<DiscoveredEndpoint>, Vec<AppWarning>) {
    let output = match hidden_command("wsl.exe")
        .args(["--list", "--running", "--quiet"])
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => output,
        Err(error) => {
            return (
                Vec::new(),
                vec![AppWarning {
                    code: "WSL_UNAVAILABLE".into(),
                    message: format!("无法调用 WSL：{error}"),
                }],
            )
        }
    };
    if !output.status.success() {
        return (Vec::new(), Vec::new());
    }

    let distributions = decode_wsl_output(&output.stdout)
        .lines()
        .map(|line| line.trim().trim_matches('\u{feff}').to_string())
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    let mut endpoints = Vec::new();
    let mut warnings = Vec::new();

    for distribution in distributions {
        let result = hidden_command("wsl.exe")
            .args(["-d", &distribution, "--", "sh", "-lc", "ss -H -lntup"])
            .stdin(Stdio::null())
            .output();
        match result {
            Ok(output) if output.status.success() => {
                let text = decode_wsl_output(&output.stdout);
                for line in text.lines() {
                    if let Some(row) = parse_ss_line(line, &distribution) {
                        endpoints.push(row);
                    }
                }
            }
            Ok(output) => warnings.push(AppWarning {
                code: "WSL_DISCOVERY_FAILED".into(),
                message: format!(
                    "WSL 发行版 {distribution} 扫描失败：{}",
                    decode_wsl_output(&output.stderr).trim()
                ),
            }),
            Err(error) => warnings.push(AppWarning {
                code: "WSL_DISCOVERY_FAILED".into(),
                message: format!("无法扫描 WSL 发行版 {distribution}：{error}"),
            }),
        }
    }
    (endpoints, warnings)
}

fn parse_ss_line(line: &str, distribution: &str) -> Option<DiscoveredEndpoint> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let protocol = if fields[0].starts_with("tcp") {
        Protocol::Tcp
    } else if fields[0].starts_with("udp") {
        Protocol::Udp
    } else {
        return None;
    };
    let local = fields.get(4)?;
    let (address, port) = parse_socket_address(local)?;
    let process_name = line
        .split("users:((\"")
        .nth(1)
        .and_then(|rest| rest.split('\"').next())
        .filter(|name| !name.is_empty())
        .map(str::to_string);
    let pid = line
        .split("pid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|value| value.parse::<u32>().ok());

    Some(DiscoveredEndpoint {
        candidate_token: String::new(),
        category: ServiceCategory::Wsl,
        category_detail: Some(distribution.to_string()),
        protocol,
        address,
        port,
        pid,
        process_name,
        process_path: None,
        port_proxy_relations: Vec::new(),
    })
}

fn parse_socket_address(value: &str) -> Option<(String, u16)> {
    if let Some(rest) = value.strip_prefix('[') {
        let (address, port) = rest.rsplit_once("]:")?;
        return Some((normalize_address(address), port.parse().ok()?));
    }
    let (address, port) = value.rsplit_once(':')?;
    Some((normalize_address(address), port.parse().ok()?))
}

pub fn resolve_wsl_address(distribution: &str, ipv6: bool) -> Result<String, String> {
    let output = hidden_command("wsl.exe")
        .args(["-d", distribution, "--", "sh", "-lc", "hostname -I"])
        .stdin(Stdio::null())
        .output()
        .map_err(|e| format!("无法解析 WSL 地址：{e}"))?;
    if !output.status.success() {
        return Err(format!(
            "WSL 地址解析失败：{}",
            decode_wsl_output(&output.stderr).trim()
        ));
    }
    let text = decode_wsl_output(&output.stdout);
    text.split_whitespace()
        .filter_map(|value| value.parse::<std::net::IpAddr>().ok())
        .find(|address| {
            address.is_ipv6() == ipv6 && !address.is_loopback() && !address.is_unspecified()
        })
        .map(|address| address.to_string())
        .ok_or_else(|| {
            if ipv6 {
                "未找到可用的 WSL IPv6 地址".to_string()
            } else {
                "未找到可用的 WSL IPv4 地址".to_string()
            }
        })
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

pub fn normalize_address(value: &str) -> String {
    match value.trim() {
        "*" => "0.0.0.0".to_string(),
        "[::]" => "::".to_string(),
        other => other.trim_matches(['[', ']']).to_string(),
    }
}

fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.len() >= 2 && bytes.iter().skip(1).step_by(2).any(|byte| *byte == 0) {
        let words = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words).replace('\0', "")
    } else {
        String::from_utf8_lossy(bytes).replace('\0', "")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ss_ipv4() {
        let row = parse_ss_line(
            "tcp LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:* users:((\"node\",pid=42,fd=3))",
            "Ubuntu",
        )
        .unwrap();
        assert_eq!(row.port, 3000);
        assert_eq!(row.address, "0.0.0.0");
        assert_eq!(row.process_name.as_deref(), Some("node"));
        assert_eq!(row.pid, Some(42));
    }

    #[test]
    fn parses_ss_ipv6() {
        let row = parse_ss_line("tcp LISTEN 0 128 [::1]:8080 [::]:*", "Ubuntu").unwrap();
        assert_eq!(row.address, "::1");
        assert_eq!(row.port, 8080);
    }

    #[test]
    fn recognizes_zero_remote_port() {
        assert!(endpoint_has_zero_port("0.0.0.0:0"));
        assert!(endpoint_has_zero_port("[::]:0"));
        assert!(!endpoint_has_zero_port("127.0.0.1:443"));
    }

    #[cfg(windows)]
    #[test]
    fn live_windows_discovery_smoke_test() {
        let rows = discover_windows().expect("Windows discovery should return valid JSON");
        assert!(rows.iter().all(|row| row.port > 0));
    }
}
