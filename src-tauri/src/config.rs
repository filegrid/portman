use crate::models::{ApiError, ConfigFile, PortProxyType, Protocol, ServiceCategory};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use uuid::Uuid;

pub fn config_dir() -> Result<PathBuf, ApiError> {
    let profile = std::env::var_os("USERPROFILE")
        .ok_or_else(|| ApiError::new("CONFIG_PATH_UNAVAILABLE", "无法确定 Windows 用户目录"))?;
    Ok(PathBuf::from(profile).join(".portman"))
}

pub fn config_path() -> Result<PathBuf, ApiError> {
    Ok(config_dir()?.join("config.yaml"))
}

pub fn load_config() -> Result<ConfigFile, ApiError> {
    let path = config_path()?;
    if !path.exists() {
        let config = ConfigFile::default();
        save_config(&config)?;
        return Ok(config);
    }

    let text = fs::read_to_string(&path)
        .map_err(|e| ApiError::new("CONFIG_READ_FAILED", format!("读取配置失败：{e}")))?;
    let config: ConfigFile = serde_yaml::from_str(&text)
        .map_err(|e| ApiError::new("CONFIG_INVALID", format!("配置 YAML 无效：{e}")))?;
    validate_config(&config)?;
    Ok(config)
}

pub fn save_config(config: &ConfigFile) -> Result<(), ApiError> {
    validate_config(config)?;
    let dir = config_dir()?;
    fs::create_dir_all(&dir)
        .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", format!("创建配置目录失败：{e}")))?;
    let path = dir.join("config.yaml");
    let temp = dir.join(format!("config.{}.tmp", Uuid::new_v4()));
    let backup = dir.join("config.yaml.bak");
    let yaml = serde_yaml::to_string(config)
        .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", format!("序列化配置失败：{e}")))?;

    let result = (|| -> Result<(), ApiError> {
        let mut file = File::create(&temp)
            .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", format!("创建临时配置失败：{e}")))?;
        file.write_all(yaml.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", format!("写入临时配置失败：{e}")))?;

        if path.exists() {
            fs::copy(&path, &backup)
                .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", format!("备份配置失败：{e}")))?;
        }
        replace_file(&temp, &path)?;
        Ok(())
    })();

    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ApiError> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let destination_wide: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect();
    let ok = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        return Err(ApiError::new(
            "CONFIG_WRITE_FAILED",
            format!("替换配置失败：{}", std::io::Error::last_os_error()),
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> Result<(), ApiError> {
    if destination.exists() {
        fs::remove_file(destination)
            .map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", e.to_string()))?;
    }
    fs::rename(source, destination).map_err(|e| ApiError::new("CONFIG_WRITE_FAILED", e.to_string()))
}

fn validate_config(config: &ConfigFile) -> Result<(), ApiError> {
    if config.version != 1 {
        return Err(ApiError::new(
            "CONFIG_VERSION_UNSUPPORTED",
            format!("不支持配置版本 {}", config.version),
        ));
    }
    let mut ids = std::collections::HashSet::new();
    let mut listeners = std::collections::HashSet::new();
    for service in &config.services {
        if service.name.trim().is_empty() || service.name.chars().count() > 80 {
            return Err(ApiError::new("CONFIG_INVALID", "服务名称长度必须为 1–80"));
        }
        if !ids.insert(&service.id) {
            return Err(ApiError::new(
                "CONFIG_INVALID",
                format!("服务 ID 重复：{}", service.id),
            ));
        }
        if service.bindings.is_empty() || service.bindings.iter().any(|binding| binding.port == 0) {
            return Err(ApiError::new(
                "CONFIG_INVALID",
                "服务必须至少包含一个有效绑定",
            ));
        }
        let mut bindings = std::collections::HashSet::new();
        if service.bindings.iter().any(|binding| {
            !bindings.insert((
                binding.protocol.as_sort_key(),
                binding.address.to_lowercase(),
                binding.port,
            ))
        }) {
            return Err(ApiError::new("CONFIG_INVALID", "服务绑定不能重复"));
        }
        if service.category == ServiceCategory::Wsl
            && service
                .identity
                .distribution
                .as_deref()
                .unwrap_or("")
                .is_empty()
        {
            return Err(ApiError::new("CONFIG_INVALID", "WSL 服务缺少 distribution"));
        }
        if let Some(forwarding) = &service.forwarding {
            if !service.bindings.iter().any(|binding| {
                binding.protocol == Protocol::Tcp
                    && binding
                        .address
                        .eq_ignore_ascii_case(&forwarding.target_address)
                    && binding.port == forwarding.target_port
            }) {
                return Err(ApiError::new(
                    "CONFIG_INVALID",
                    "端口转发目标必须是该服务的 TCP 绑定",
                ));
            }
            validate_forwarding_address(
                forwarding.proxy_type,
                &forwarding.listen_address,
                forwarding.connect_address.as_deref(),
            )?;
            let key = format!(
                "{}:{}",
                forwarding.listen_address.to_lowercase(),
                forwarding.external_port
            );
            if !listeners.insert(key) {
                return Err(ApiError::new("CONFIG_INVALID", "外部监听端点重复"));
            }
        }
    }
    let mut mapping_listeners = std::collections::HashSet::new();
    for mapping in &config.port_mappings {
        if mapping.external_port == 0 || mapping.target_port == 0 {
            return Err(ApiError::new(
                "CONFIG_INVALID",
                "独立映射端口必须在 1–65535 之间",
            ));
        }
        validate_forwarding_address(
            mapping.proxy_type,
            &mapping.listen_address,
            Some(&mapping.connect_address),
        )?;
        let key = format!(
            "{}:{}",
            mapping.listen_address.to_lowercase(),
            mapping.external_port
        );
        if !mapping_listeners.insert(key) {
            return Err(ApiError::new("CONFIG_INVALID", "映射监听端点重复"));
        }
    }
    Ok(())
}

pub fn validate_forwarding_address(
    proxy_type: PortProxyType,
    listen_address: &str,
    connect_address: Option<&str>,
) -> Result<(), ApiError> {
    let listen = listen_address
        .parse::<std::net::IpAddr>()
        .map_err(|_| ApiError::new("INVALID_ADDRESS", "监听地址必须是有效 IP 地址"))?;
    if listen.is_ipv6() != proxy_type.listens_ipv6() {
        return Err(ApiError::new(
            "INVALID_PROXY_TYPE",
            "代理类型与监听地址族不一致",
        ));
    }
    if let Some(connect_address) = connect_address.filter(|value| !value.trim().is_empty()) {
        let connect = connect_address
            .parse::<std::net::IpAddr>()
            .map_err(|_| ApiError::new("INVALID_ADDRESS", "目标地址必须是有效 IP 地址"))?;
        if connect.is_ipv6() != proxy_type.connects_ipv6() {
            return Err(ApiError::new(
                "INVALID_PROXY_TYPE",
                "代理类型与目标地址族不一致",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config_is_valid_and_uses_v4tov4() {
        let config = ConfigFile::default();
        validate_config(&config).unwrap();
        assert_eq!(config.settings.default_proxy_type, PortProxyType::V4ToV4);
        assert_eq!(config.settings.default_external_address, "127.0.0.1");
    }

    #[test]
    fn rejects_address_family_mismatch() {
        let error = validate_forwarding_address(PortProxyType::V4ToV4, "::1", None)
            .expect_err("IPv6 listener cannot be used with v4tov4");
        assert_eq!(error.code, "INVALID_PROXY_TYPE");
    }
}
