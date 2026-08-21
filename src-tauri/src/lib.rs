mod config;
mod discovery;
mod models;
mod portproxy;

use config::{config_path, load_config, save_config, validate_forwarding_address};
use discovery::{discover_all, normalize_address, resolve_wsl_address};
use models::*;
use portproxy::PortProxyRule;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

struct AppState {
    candidates: Mutex<HashMap<String, DiscoveredEndpoint>>,
    operation_lock: Mutex<()>,
}

#[tauri::command]
fn get_dashboard_snapshot() -> Result<DashboardSnapshot, ApiError> {
    let config = load_config()?;
    let rules_result = portproxy::read_rules();
    let include_wsl = !config.port_mappings.is_empty()
        || rules_result.as_ref().is_ok_and(|rules| !rules.is_empty())
        || config
            .services
            .iter()
            .any(|service| service.category == ServiceCategory::Wsl);
    let (detected, mut warnings) = discover_all(include_wsl);
    let rules = match rules_result {
        Ok(rules) => rules,
        Err(error) => {
            warnings.push(AppWarning {
                code: error.code,
                message: error.message,
            });
            Vec::new()
        }
    };
    let ip_helper_state = portproxy::ip_helper_state();
    let mut services = config
        .services
        .iter()
        .map(|service| {
            let actual_rules = rules
                .iter()
                .filter(|rule| {
                    rule_owner_service(rule, &config.services)
                        .is_some_and(|owner| owner.id == service.id)
                })
                .cloned()
                .collect::<Vec<_>>();
            build_service_view(service, &detected, &rules, &actual_rules, &ip_helper_state)
        })
        .collect::<Vec<_>>();
    services.sort_by_key(|service| {
        service
            .bindings
            .iter()
            .map(|binding| binding.port)
            .min()
            .unwrap_or(u16::MAX)
    });
    let mut port_mappings = rules
        .iter()
        .map(|rule| ActualForwardingView {
            proxy_type: rule.proxy_type,
            listen_address: rule.listen_address.clone(),
            external_port: rule.listen_port,
            connect_address: rule.connect_address.clone(),
            target_port: rule.connect_port,
            enabled: true,
            source_available: mapping_source_available(rule, &detected, &rules),
        })
        .collect::<Vec<_>>();
    for configured in &config.port_mappings {
        let is_active = rules
            .iter()
            .any(|rule| port_mapping_config_matches_rule(configured, rule));
        if !is_active {
            port_mappings.push(ActualForwardingView {
                proxy_type: configured.proxy_type,
                listen_address: configured.listen_address.clone(),
                external_port: configured.external_port,
                connect_address: configured.connect_address.clone(),
                target_port: configured.target_port,
                enabled: false,
                source_available: mapping_source_endpoint_available(
                    &configured.connect_address,
                    configured.target_port,
                    &detected,
                    &rules,
                ),
            });
        }
    }
    port_mappings.sort_by(|left, right| {
        left.external_port
            .cmp(&right.external_port)
            .then_with(|| left.listen_address.cmp(&right.listen_address))
            .then_with(|| left.proxy_type.as_str().cmp(right.proxy_type.as_str()))
    });
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    Ok(DashboardSnapshot {
        generated_at,
        services,
        port_mappings,
        system: SystemView { ip_helper_state },
        warnings,
        config_path: config_path()?.display().to_string(),
    })
}

#[tauri::command]
fn discover_candidates(state: tauri::State<'_, AppState>) -> Result<DiscoveryResult, ApiError> {
    let config = load_config()?;
    let (mut detected, mut warnings) = discover_all(true);
    match portproxy::read_rules() {
        Ok(rules) => {
            for candidate in &mut detected {
                for rule in &rules {
                    let is_listener = candidate.category == ServiceCategory::Windows
                        && candidate.protocol == Protocol::Tcp
                        && rule.listen_port == candidate.port
                        && normalize_address(&rule.listen_address)
                            == normalize_address(&candidate.address);
                    if is_listener {
                        candidate.port_proxy_relations.push(PortProxyRelation {
                            role: "source".into(),
                            other_port: rule.connect_port,
                        });
                    } else if rule.connect_port == candidate.port {
                        candidate.port_proxy_relations.push(PortProxyRelation {
                            role: "target".into(),
                            other_port: rule.listen_port,
                        });
                    }
                }
            }
        }
        Err(error) => warnings.push(AppWarning {
            code: error.code,
            message: error.message,
        }),
    }
    detected.retain(|candidate| {
        !candidate
            .port_proxy_relations
            .iter()
            .any(|relation| relation.role == "source")
    });
    detected.retain(|candidate| {
        !config
            .services
            .iter()
            .any(|service| candidate_matches_service_port(candidate, service))
    });
    detected.sort_by(|left, right| {
        left.port
            .cmp(&right.port)
            .then_with(|| {
                left.protocol
                    .as_sort_key()
                    .cmp(&right.protocol.as_sort_key())
            })
            .then_with(|| left.address.cmp(&right.address))
    });

    let mut cache = state
        .candidates
        .lock()
        .map_err(|_| ApiError::new("INTERNAL_ERROR", "候选缓存不可用"))?;
    cache.clear();
    for candidate in &mut detected {
        let token = Uuid::new_v4().to_string();
        candidate.candidate_token = token.clone();
        cache.insert(token, candidate.clone());
    }
    Ok(DiscoveryResult {
        candidates: detected,
        warnings,
    })
}

#[tauri::command]
fn create_service(
    request: CreateServiceRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let name = request.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::new("INVALID_NAME", "服务名称长度必须为 1–80"));
    }
    if request.candidate_tokens.is_empty() {
        return Err(ApiError::new("INVALID_CANDIDATE", "请选择一个服务来源"));
    }
    let candidates = {
        let mut cache = state
            .candidates
            .lock()
            .map_err(|_| ApiError::new("INTERNAL_ERROR", "候选缓存不可用"))?;
        request
            .candidate_tokens
            .iter()
            .map(|token| {
                cache
                    .remove(token)
                    .ok_or_else(|| ApiError::new("CANDIDATE_STALE", "候选已过期，请刷新后重试"))
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let candidate = candidates.first().expect("candidate list was checked");
    if candidates
        .iter()
        .any(|row| !same_port_group(row, candidate))
    {
        return Err(ApiError::new(
            "INVALID_CANDIDATE",
            "所选绑定不属于同一个端口",
        ));
    }
    let (current, _) = discover_all(candidate.category == ServiceCategory::Wsl);
    if candidates
        .iter()
        .any(|saved| !current.iter().any(|row| candidate_equivalent(row, saved)))
    {
        return Err(ApiError::new(
            "CANDIDATE_STALE",
            "该服务的绑定已经变化，请刷新后重试",
        ));
    }

    let mut config = load_config()?;
    if config
        .services
        .iter()
        .any(|service| candidate_matches_service_port(candidate, service))
    {
        return Err(ApiError::new("SERVICE_EXISTS", "该服务已经在关注列表中"));
    }
    config.services.push(TrackedService {
        id: Uuid::new_v4().to_string(),
        name: name.to_string(),
        category: candidate.category,
        bindings: {
            let mut bindings = candidates
                .iter()
                .map(|row| ServiceBinding {
                    protocol: row.protocol,
                    address: row.address.clone(),
                    port: row.port,
                })
                .collect::<Vec<_>>();
            bindings.sort_by(|left, right| {
                left.port
                    .cmp(&right.port)
                    .then_with(|| {
                        left.protocol
                            .as_sort_key()
                            .cmp(&right.protocol.as_sort_key())
                    })
                    .then_with(|| left.address.cmp(&right.address))
            });
            bindings.dedup_by(|left, right| {
                left.protocol == right.protocol
                    && normalize_address(&left.address) == normalize_address(&right.address)
                    && left.port == right.port
            });
            bindings
        },
        identity: ServiceIdentity {
            process_path: candidate.process_path.clone(),
            process_name: candidate.process_name.clone(),
            distribution: candidate.category_detail.clone(),
        },
        forwarding: None,
    });
    save_config(&config)?;
    Ok(OperationResult {
        message: "服务已加入关注".into(),
    })
}

#[tauri::command]
fn open_service_process_directory(request: ServiceIdRequest) -> Result<OperationResult, ApiError> {
    let config = load_config()?;
    let service = config
        .services
        .iter()
        .find(|service| service.id == request.service_id)
        .ok_or_else(|| ApiError::new("SERVICE_NOT_FOUND", "服务不存在"))?;
    if service.category == ServiceCategory::Wsl {
        return Err(ApiError::new(
            "PROCESS_PATH_UNAVAILABLE",
            "WSL 进程没有可直接打开的 Windows 可执行文件目录",
        ));
    }
    let (detected, _) = discover_all(false);
    let path = detected
        .iter()
        .find(|candidate| candidate_matches_service_port(candidate, service))
        .and_then(|candidate| candidate.process_path.as_deref())
        .or(service.identity.process_path.as_deref())
        .ok_or_else(|| {
            ApiError::new("PROCESS_PATH_UNAVAILABLE", "无法读取该进程的可执行文件路径")
        })?;
    open_executable_directory(path)
}

#[tauri::command]
fn open_candidate_process_directory(
    request: CandidateTokenRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let cache = state
        .candidates
        .lock()
        .map_err(|_| ApiError::new("INTERNAL_ERROR", "候选缓存不可用"))?;
    let candidate = cache
        .get(&request.candidate_token)
        .ok_or_else(|| ApiError::new("CANDIDATE_STALE", "候选已过期，请刷新后重试"))?;
    let path = candidate.process_path.as_deref().ok_or_else(|| {
        ApiError::new("PROCESS_PATH_UNAVAILABLE", "无法读取该进程的可执行文件路径")
    })?;
    open_executable_directory(path)
}

fn open_executable_directory(path: &str) -> Result<OperationResult, ApiError> {
    let directory = std::path::Path::new(path)
        .parent()
        .filter(|directory| directory.is_dir())
        .ok_or_else(|| ApiError::new("PROCESS_PATH_UNAVAILABLE", "进程可执行文件目录不存在"))?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("explorer.exe")
            .arg(directory)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| {
                ApiError::new(
                    "OPEN_DIRECTORY_FAILED",
                    format!("打开进程目录失败：{error}"),
                )
            })?;
    }
    Ok(OperationResult {
        message: "已打开进程所在目录".into(),
    })
}

#[tauri::command]
fn create_forwarding(
    request: CreateForwardingRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let index = find_service_index(&config, &request.service_id)?;
    if !config.services[index].bindings.iter().any(|binding| {
        binding.protocol == Protocol::Tcp
            && normalize_address(&binding.address)
                == normalize_address(request.target_address.trim())
            && binding.port == request.target_port
    }) {
        return Err(ApiError::new(
            "UNSUPPORTED_PROTOCOL",
            "转发目标必须是该服务当前记录的 TCP 绑定",
        ));
    }
    if request.external_port == 0 {
        return Err(ApiError::new("INVALID_PORT", "外部端口必须在 1–65535 之间"));
    }
    if config.services[index].forwarding.is_some() {
        return Err(ApiError::new("FORWARDING_EXISTS", "该服务已经配置端口转发"));
    }
    validate_forwarding_address(
        request.proxy_type,
        request.listen_address.trim(),
        request.connect_address.as_deref(),
    )?;
    ensure_config_listener_available(
        &config,
        &request.service_id,
        request.listen_address.trim(),
        request.external_port,
    )?;

    let mut forwarding = ForwardingConfig {
        proxy_type: request.proxy_type,
        listen_address: request.listen_address.trim().to_string(),
        external_port: request.external_port,
        target_address: request.target_address.trim().to_string(),
        target_port: request.target_port,
        connect_address: request
            .connect_address
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        last_applied_connect_address: None,
        enabled: false,
    };
    if request.enabled {
        let rule = make_rule(&config.services[index], &forwarding)?;
        ensure_system_listener_available(&rule)?;
        portproxy::add_rule(rule.clone())?;
        forwarding.enabled = true;
        forwarding.last_applied_connect_address = Some(rule.connect_address.clone());
        config.services[index].forwarding = Some(forwarding);
        if let Err(error) = save_config(&config) {
            let _ = portproxy::delete_rule(rule);
            return Err(error);
        }
    } else {
        config.services[index].forwarding = Some(forwarding);
        save_config(&config)?;
    }
    Ok(OperationResult {
        message: if request.enabled {
            "端口转发已创建并启用".into()
        } else {
            "端口转发配置已保存".into()
        },
    })
}

#[tauri::command]
fn set_forwarding_enabled(
    request: SetForwardingEnabledRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let index = find_service_index(&config, &request.service_id)?;
    let forwarding = config.services[index]
        .forwarding
        .clone()
        .ok_or_else(|| ApiError::new("FORWARDING_NOT_FOUND", "该服务尚未配置端口转发"))?;
    if forwarding.enabled == request.enabled {
        return Ok(OperationResult {
            message: if request.enabled {
                "端口转发已启用"
            } else {
                "端口转发已禁用"
            }
            .into(),
        });
    }

    if request.enabled {
        let rule = make_rule(&config.services[index], &forwarding)?;
        ensure_system_listener_available(&rule)?;
        portproxy::add_rule(rule.clone())?;
        let target = rule.connect_address.clone();
        let current = config.services[index].forwarding.as_mut().unwrap();
        current.enabled = true;
        current.last_applied_connect_address = Some(target);
        if let Err(error) = save_config(&config) {
            let _ = portproxy::delete_rule(rule);
            return Err(error);
        }
        Ok(OperationResult {
            message: "端口转发已启用".into(),
        })
    } else {
        let rule = make_owned_rule_for_delete(&config.services[index], &forwarding)?;
        portproxy::delete_rule(rule.clone())?;
        let current = config.services[index].forwarding.as_mut().unwrap();
        current.enabled = false;
        if let Err(error) = save_config(&config) {
            let _ = portproxy::add_rule(rule);
            return Err(error);
        }
        Ok(OperationResult {
            message: "端口转发已禁用".into(),
        })
    }
}

#[tauri::command]
fn create_port_mapping(
    request: PortMappingRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let rule = port_mapping_rule(&request)?;
    let (detected, _) = discover_all(true);
    let existing = portproxy::read_rules()?;
    let source_available = mapping_source_available(&rule, &detected, &existing);
    let source = format!("{}:{}", rule.connect_address, rule.connect_port);
    ensure_system_listener_available(&rule)?;
    portproxy::add_rule(rule)?;
    Ok(OperationResult {
        message: if source_available {
            "端口映射已添加".into()
        } else {
            format!("端口映射已添加；服务源 {source} 当前没有 TCP 监听")
        },
    })
}

#[tauri::command]
fn create_port_mappings(
    request: CreatePortMappingsRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    if request.mappings.is_empty() || request.mappings.len() > 256 {
        return Err(ApiError::new(
            "INVALID_BATCH",
            "每次必须添加 1–256 条端口映射",
        ));
    }
    let existing = portproxy::read_rules()?;
    let (detected, _) = discover_all(true);
    let mut rules = Vec::with_capacity(request.mappings.len());
    let mut unavailable_sources = Vec::new();
    for mapping in &request.mappings {
        let rule = port_mapping_rule(mapping)?;
        if !mapping_source_available(&rule, &detected, &existing) {
            unavailable_sources.push(format!("{}:{}", rule.connect_address, rule.connect_port));
        }
        if let Some(conflict) = existing.iter().chain(rules.iter()).find(|item| {
            normalize_address(&item.listen_address) == normalize_address(&rule.listen_address)
                && item.listen_port == rule.listen_port
        }) {
            return Err(ApiError::new(
                "PORT_CONFLICT",
                format!(
                    "映射目标 {}:{} 已指向 {}:{}",
                    conflict.listen_address,
                    conflict.listen_port,
                    conflict.connect_address,
                    conflict.connect_port
                ),
            ));
        }
        rules.push(rule);
    }
    let count = rules.len();
    let original_len = config.port_mappings.len();
    config
        .port_mappings
        .extend(rules.iter().map(|rule| port_mapping_config(rule, false)));
    save_config(&config)?;
    if let Err(error) = portproxy::add_rules(rules.clone()) {
        config.port_mappings.truncate(original_len);
        let _ = save_config(&config);
        return Err(error);
    }
    for configured in &mut config.port_mappings[original_len..] {
        configured.enabled = true;
    }
    save_config(&config)?;
    Ok(OperationResult {
        message: if unavailable_sources.is_empty() {
            format!("已添加 {count} 条端口映射")
        } else {
            format!(
                "已添加 {count} 条端口映射；以下服务源当前没有 TCP 监听：{}",
                unavailable_sources.join("、")
            )
        },
    })
}

#[tauri::command]
fn delete_port_mapping(
    request: PortMappingRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let requested = port_mapping_rule(&request)?;
    let active_rule = portproxy::read_rules()?.into_iter().find(|rule| {
        port_mapping_config_matches_rule(&port_mapping_config(rule, true), &requested)
    });
    let original_len = config.port_mappings.len();
    config
        .port_mappings
        .retain(|configured| !port_mapping_config_matches_rule(configured, &requested));
    if active_rule.is_none() && config.port_mappings.len() == original_len {
        return Err(ApiError::new("MAPPING_NOT_FOUND", "该端口映射已不存在"));
    }
    if let Some(rule) = &active_rule {
        portproxy::delete_rule(rule.clone())?;
    }
    if let Err(error) = save_config(&config) {
        if let Some(rule) = active_rule {
            let _ = portproxy::add_rule(rule);
        }
        return Err(error);
    }
    Ok(OperationResult {
        message: "端口映射已删除".into(),
    })
}

#[tauri::command]
fn set_port_mapping_enabled(
    request: SetPortMappingEnabledRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let requested = port_mapping_rule(&request.mapping)?;
    let configured_index = config
        .port_mappings
        .iter()
        .position(|configured| port_mapping_config_matches_rule(configured, &requested));

    if request.enabled {
        let (detected, _) = discover_all(true);
        let existing = portproxy::read_rules()?;
        let source_available = mapping_source_available(&requested, &detected, &existing);
        let source = format!("{}:{}", requested.connect_address, requested.connect_port);
        ensure_system_listener_available(&requested)?;
        portproxy::add_rule(requested.clone())?;
        if let Some(index) = configured_index {
            config.port_mappings[index].enabled = true;
        } else {
            config
                .port_mappings
                .push(port_mapping_config(&requested, true));
        }
        if let Err(error) = save_config(&config) {
            let _ = portproxy::delete_rule(requested);
            return Err(error);
        }
        Ok(OperationResult {
            message: if source_available {
                "端口映射已启用".into()
            } else {
                format!("端口映射已启用；服务源 {source} 当前没有 TCP 监听")
            },
        })
    } else {
        let active_rule = portproxy::read_rules()?.into_iter().find(|rule| {
            port_mapping_config_matches_rule(&port_mapping_config(rule, true), &requested)
        });
        if let Some(rule) = &active_rule {
            portproxy::delete_rule(rule.clone())?;
        }
        if let Some(index) = configured_index {
            config.port_mappings[index].enabled = false;
        } else {
            config
                .port_mappings
                .push(port_mapping_config(&requested, false));
        }
        if let Err(error) = save_config(&config) {
            if let Some(rule) = active_rule {
                let _ = portproxy::add_rule(rule);
            }
            return Err(error);
        }
        Ok(OperationResult {
            message: "端口映射已禁用".into(),
        })
    }
}

#[tauri::command]
fn delete_forwarding(
    request: ServiceIdRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let index = find_service_index(&config, &request.service_id)?;
    let forwarding = config.services[index]
        .forwarding
        .clone()
        .ok_or_else(|| ApiError::new("FORWARDING_NOT_FOUND", "该服务尚未配置端口转发"))?;
    let removed_rule = if forwarding.enabled {
        let rule = make_owned_rule_for_delete(&config.services[index], &forwarding)?;
        portproxy::delete_rule(rule.clone())?;
        Some(rule)
    } else {
        None
    };
    config.services[index].forwarding = None;
    if let Err(error) = save_config(&config) {
        if let Some(rule) = removed_rule {
            let _ = portproxy::add_rule(rule);
        }
        return Err(error);
    }
    Ok(OperationResult {
        message: "端口转发已删除".into(),
    })
}

#[tauri::command]
fn remove_service(
    request: ServiceIdRequest,
    state: tauri::State<'_, AppState>,
) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    let mut config = load_config()?;
    let index = find_service_index(&config, &request.service_id)?;
    let removed_rule = match config.services[index].forwarding.clone() {
        Some(forwarding) if forwarding.enabled => {
            let rule = make_owned_rule_for_delete(&config.services[index], &forwarding)?;
            portproxy::delete_rule(rule.clone())?;
            Some(rule)
        }
        _ => None,
    };
    config.services.remove(index);
    if let Err(error) = save_config(&config) {
        if let Some(rule) = removed_rule {
            let _ = portproxy::add_rule(rule);
        }
        return Err(error);
    }
    Ok(OperationResult {
        message: "已取消关注服务".into(),
    })
}

#[tauri::command]
fn start_ip_helper_service(state: tauri::State<'_, AppState>) -> Result<OperationResult, ApiError> {
    let _operation = lock_operation(&state)?;
    portproxy::start_ip_helper()?;
    Ok(OperationResult {
        message: "IP Helper 已启动".into(),
    })
}

fn lock_operation<'a>(
    state: &'a tauri::State<'_, AppState>,
) -> Result<std::sync::MutexGuard<'a, ()>, ApiError> {
    state
        .operation_lock
        .try_lock()
        .map_err(|_| ApiError::new("OPERATION_IN_PROGRESS", "另一个系统操作正在进行中"))
}

fn find_service_index(config: &ConfigFile, service_id: &str) -> Result<usize, ApiError> {
    config
        .services
        .iter()
        .position(|service| service.id == service_id)
        .ok_or_else(|| ApiError::new("SERVICE_NOT_FOUND", "服务不存在或已被删除"))
}

fn ensure_config_listener_available(
    config: &ConfigFile,
    service_id: &str,
    address: &str,
    port: u16,
) -> Result<(), ApiError> {
    if config.services.iter().any(|service| {
        service.id != service_id
            && service.forwarding.as_ref().is_some_and(|forwarding| {
                normalize_address(&forwarding.listen_address) == normalize_address(address)
                    && forwarding.external_port == port
            })
    }) {
        return Err(ApiError::new(
            "PORT_CONFLICT",
            "该外部监听端点已被另一关注服务使用",
        ));
    }
    Ok(())
}

fn ensure_system_listener_available(rule: &PortProxyRule) -> Result<(), ApiError> {
    let rules = portproxy::read_rules()?;
    if let Some(existing) = rules.iter().find(|existing| {
        normalize_address(&existing.listen_address) == normalize_address(&rule.listen_address)
            && existing.listen_port == rule.listen_port
    }) {
        if existing == rule {
            return Ok(());
        }
        return Err(ApiError::new(
            "PORT_CONFLICT",
            format!(
                "外部端点 {}:{} 已转发到 {}:{}",
                existing.listen_address,
                existing.listen_port,
                existing.connect_address,
                existing.connect_port
            ),
        ));
    }
    Ok(())
}

fn mapping_source_available(
    rule: &PortProxyRule,
    detected: &[DiscoveredEndpoint],
    portproxy_rules: &[PortProxyRule],
) -> bool {
    mapping_source_endpoint_available(
        &rule.connect_address,
        rule.connect_port,
        detected,
        portproxy_rules,
    )
}

fn mapping_source_endpoint_available(
    connect_address: &str,
    connect_port: u16,
    detected: &[DiscoveredEndpoint],
    portproxy_rules: &[PortProxyRule],
) -> bool {
    detected.iter().any(|candidate| {
        candidate.protocol == Protocol::Tcp
            && candidate.port == connect_port
            && ((!is_portproxy_listener(&candidate.address, candidate.port, portproxy_rules)
                && mapping_source_address_matches(connect_address, &candidate.address))
                || is_wsl_relay_source(candidate, connect_address))
    })
}

fn is_wsl_relay_source(candidate: &DiscoveredEndpoint, connect_address: &str) -> bool {
    is_wsl_relay(candidate)
        && normalize_address(connect_address)
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| match address {
                std::net::IpAddr::V4(address) => address.is_private(),
                std::net::IpAddr::V6(address) => address.is_unique_local(),
            })
}

fn is_portproxy_listener(address: &str, port: u16, rules: &[PortProxyRule]) -> bool {
    rules.iter().any(|rule| {
        rule.listen_port == port
            && normalize_address(&rule.listen_address) == normalize_address(address)
    })
}

fn mapping_source_address_matches(requested: &str, listening: &str) -> bool {
    if normalize_address(requested) == normalize_address(listening) {
        return true;
    }
    let (Ok(requested), Ok(listening)) = (
        normalize_address(requested).parse::<std::net::IpAddr>(),
        normalize_address(listening).parse::<std::net::IpAddr>(),
    ) else {
        return false;
    };
    requested.is_ipv4() == listening.is_ipv4()
        && (requested.is_unspecified() || listening.is_unspecified())
}

fn port_mapping_rule(request: &PortMappingRequest) -> Result<PortProxyRule, ApiError> {
    if request.external_port == 0 || request.target_port == 0 {
        return Err(ApiError::new(
            "INVALID_PORT",
            "监听端口和目标端口必须在 1–65535 之间",
        ));
    }
    let listen_address = request.listen_address.trim();
    let connect_address = request.connect_address.trim();
    validate_forwarding_address(request.proxy_type, listen_address, Some(connect_address))?;
    Ok(PortProxyRule {
        proxy_type: request.proxy_type,
        listen_address: normalize_address(listen_address),
        listen_port: request.external_port,
        connect_address: normalize_address(connect_address),
        connect_port: request.target_port,
    })
}

fn port_mapping_config(rule: &PortProxyRule, enabled: bool) -> PortMappingConfig {
    PortMappingConfig {
        proxy_type: rule.proxy_type,
        listen_address: rule.listen_address.clone(),
        external_port: rule.listen_port,
        connect_address: rule.connect_address.clone(),
        target_port: rule.connect_port,
        enabled,
    }
}

fn port_mapping_config_matches_rule(configured: &PortMappingConfig, rule: &PortProxyRule) -> bool {
    configured.proxy_type == rule.proxy_type
        && normalize_address(&configured.listen_address) == normalize_address(&rule.listen_address)
        && configured.external_port == rule.listen_port
        && normalize_address(&configured.connect_address)
            == normalize_address(&rule.connect_address)
        && configured.target_port == rule.connect_port
}

fn make_rule(
    service: &TrackedService,
    forwarding: &ForwardingConfig,
) -> Result<PortProxyRule, ApiError> {
    let connect_address = match forwarding
        .connect_address
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        Some(address) => address.to_string(),
        None if service.category == ServiceCategory::Wsl => {
            let distribution = service.identity.distribution.as_deref().ok_or_else(|| {
                ApiError::new("WSL_ADDRESS_UNAVAILABLE", "服务缺少 WSL 发行版信息")
            })?;
            resolve_wsl_address(distribution, forwarding.proxy_type.connects_ipv6())
                .map_err(|e| ApiError::new("WSL_ADDRESS_UNAVAILABLE", e))?
        }
        None => default_windows_connect_address(&forwarding.target_address, forwarding.proxy_type)?,
    };
    validate_forwarding_address(
        forwarding.proxy_type,
        &forwarding.listen_address,
        Some(&connect_address),
    )?;
    Ok(PortProxyRule {
        proxy_type: forwarding.proxy_type,
        listen_address: normalize_address(&forwarding.listen_address),
        listen_port: forwarding.external_port,
        connect_address: normalize_address(&connect_address),
        connect_port: forwarding.target_port,
    })
}

fn make_owned_rule_for_delete(
    service: &TrackedService,
    forwarding: &ForwardingConfig,
) -> Result<PortProxyRule, ApiError> {
    let connect_address = match forwarding
        .last_applied_connect_address
        .clone()
        .or_else(|| forwarding.connect_address.clone())
    {
        Some(address) => address,
        None => make_rule(service, forwarding)?.connect_address,
    };
    Ok(PortProxyRule {
        proxy_type: forwarding.proxy_type,
        listen_address: normalize_address(&forwarding.listen_address),
        listen_port: forwarding.external_port,
        connect_address: normalize_address(&connect_address),
        connect_port: forwarding.target_port,
    })
}

fn default_windows_connect_address(
    address: &str,
    proxy_type: PortProxyType,
) -> Result<String, ApiError> {
    let parsed = address.parse::<std::net::IpAddr>().ok();
    if proxy_type.connects_ipv6() {
        match parsed {
            Some(std::net::IpAddr::V6(address)) if !address.is_unspecified() => {
                Ok(address.to_string())
            }
            Some(std::net::IpAddr::V6(_)) => Ok("::1".into()),
            _ => Err(ApiError::new(
                "CONNECT_ADDRESS_REQUIRED",
                "该高级代理类型需要填写 IPv6 目标地址",
            )),
        }
    } else {
        match parsed {
            Some(std::net::IpAddr::V4(address)) if !address.is_unspecified() => {
                Ok(address.to_string())
            }
            Some(std::net::IpAddr::V4(_)) => Ok("127.0.0.1".into()),
            _ => Err(ApiError::new(
                "CONNECT_ADDRESS_REQUIRED",
                "该高级代理类型需要填写 IPv4 目标地址",
            )),
        }
    }
}

fn rule_owner_service<'a>(
    rule: &PortProxyRule,
    services: &'a [TrackedService],
) -> Option<&'a TrackedService> {
    let candidates = services
        .iter()
        .filter(|service| {
            service.bindings.iter().any(|binding| {
                binding.protocol == Protocol::Tcp && binding.port == rule.connect_port
            })
        })
        .collect::<Vec<_>>();
    if candidates.len() <= 1 {
        return candidates.first().copied();
    }
    if let Some(exact) = candidates.iter().find(|service| {
        service.bindings.iter().any(|binding| {
            binding.protocol == Protocol::Tcp
                && binding.port == rule.connect_port
                && binding
                    .address
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|address| !address.is_unspecified())
                && normalize_address(&binding.address) == normalize_address(&rule.connect_address)
        })
    }) {
        return Some(exact);
    }
    let target_is_loopback = rule.connect_address.eq_ignore_ascii_case("localhost")
        || rule
            .connect_address
            .parse::<std::net::IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    let preferred_category = if target_is_loopback {
        ServiceCategory::Windows
    } else {
        ServiceCategory::Wsl
    };
    candidates
        .iter()
        .find(|service| service.category == preferred_category)
        .copied()
        .or_else(|| candidates.first().copied())
}

fn actual_forwarding_state(
    service: &TrackedService,
    actual_rules: &[PortProxyRule],
    all_rules: &[PortProxyRule],
    ip_helper_state: &str,
    diagnostics: &mut Vec<Diagnostic>,
) -> String {
    if !actual_rules.is_empty() {
        if ip_helper_state != "running" {
            diagnostics.push(Diagnostic {
                code: "IP_HELPER_STOPPED".into(),
                message: "系统存在 PortProxy 规则，但 IP Helper 未运行".into(),
            });
            return "error".into();
        }
        let Some(configured) = service.forwarding.as_ref() else {
            return "active".into();
        };
        if !configured.enabled {
            diagnostics.push(Diagnostic {
                code: "UNEXPECTED_SYSTEM_RULE".into(),
                message: "Portman 配置已禁用，但系统中存在实际转发规则".into(),
            });
            return "conflict".into();
        }
        return match make_rule(service, configured) {
            Ok(expected) if actual_rules.iter().any(|actual| actual == &expected) => {
                "active".into()
            }
            Ok(_) => {
                diagnostics.push(Diagnostic {
                    code: "FORWARDING_CONFLICT".into(),
                    message: "系统实际转发与 Portman 配置不一致".into(),
                });
                "conflict".into()
            }
            Err(error) => {
                diagnostics.push(Diagnostic {
                    code: error.code,
                    message: error.message,
                });
                "conflict".into()
            }
        };
    }

    match service.forwarding.as_ref() {
        None => "unconfigured".into(),
        Some(forwarding) if !forwarding.enabled => "disabled".into(),
        Some(_) if ip_helper_state != "running" => {
            diagnostics.push(Diagnostic {
                code: "IP_HELPER_STOPPED".into(),
                message: "IP Helper 未运行，配置的转发无法生效".into(),
            });
            "error".into()
        }
        Some(forwarding) => {
            if let Some(actual) = all_rules.iter().find(|rule| {
                normalize_address(&rule.listen_address)
                    == normalize_address(&forwarding.listen_address)
                    && rule.listen_port == forwarding.external_port
            }) {
                diagnostics.push(Diagnostic {
                    code: "FORWARDING_CONFLICT".into(),
                    message: format!(
                        "配置的外部端点实际转发到 {}:{}",
                        actual.connect_address, actual.connect_port
                    ),
                });
                "conflict".into()
            } else {
                diagnostics.push(Diagnostic {
                    code: "FORWARDING_MISSING".into(),
                    message: "Portman 已启用配置，但系统实际规则不存在".into(),
                });
                "repair_required".into()
            }
        }
    }
}

fn build_service_view(
    service: &TrackedService,
    detected: &[DiscoveredEndpoint],
    rules: &[PortProxyRule],
    actual_rules: &[PortProxyRule],
    ip_helper_state: &str,
) -> ServiceView {
    let service_candidates = detected
        .iter()
        .filter(|candidate| candidate_matches_service_port(candidate, service))
        .collect::<Vec<_>>();
    let bindings = service
        .bindings
        .iter()
        .map(|binding| BindingView {
            protocol: binding.protocol,
            address: binding.address.clone(),
            port: binding.port,
            active: service_candidates
                .iter()
                .any(|candidate| binding_matches_candidate(binding, candidate)),
        })
        .collect::<Vec<_>>();
    let current = service_candidates
        .iter()
        .find(|candidate| candidate.category == service.category)
        .copied()
        .or_else(|| service_candidates.first().copied());
    let actual_forwardings = actual_rules
        .iter()
        .map(|rule| ActualForwardingView {
            proxy_type: rule.proxy_type,
            listen_address: rule.listen_address.clone(),
            external_port: rule.listen_port,
            connect_address: rule.connect_address.clone(),
            target_port: rule.connect_port,
            enabled: true,
            source_available: mapping_source_available(rule, detected, rules),
        })
        .collect::<Vec<_>>();
    let directly_exposed = service_candidates.iter().any(|candidate| {
        (service.category == ServiceCategory::Windows
            || candidate.category == ServiceCategory::Windows)
            && is_network_listener(&candidate.address)
    });
    let network_exposed = directly_exposed
        || actual_rules
            .iter()
            .any(|rule| is_network_listener(&rule.listen_address));
    let (runtime_state, process, mut diagnostics) = if let Some(candidate) = current {
        (
            "running".to_string(),
            Some(ProcessView {
                pid: candidate.pid,
                name: candidate.process_name.clone(),
                path: candidate.process_path.clone(),
            }),
            Vec::new(),
        )
    } else {
        ("stopped".to_string(), None, Vec::new())
    };

    let external = actual_rules.first().map(|rule| EndpointView {
        address: rule.listen_address.clone(),
        port: rule.listen_port,
    });
    let forwarding_view = service
        .forwarding
        .as_ref()
        .map(|forwarding| ForwardingView {
            proxy_type: forwarding.proxy_type,
            listen_address: forwarding.listen_address.clone(),
            external_port: forwarding.external_port,
            target_address: forwarding.target_address.clone(),
            target_port: forwarding.target_port,
            connect_address: forwarding.connect_address.clone(),
            enabled: forwarding.enabled,
        });
    let mut forwarding_state = actual_forwarding_state(
        service,
        actual_rules,
        rules,
        ip_helper_state,
        &mut diagnostics,
    );
    if service.category == ServiceCategory::Windows
        && directly_exposed
        && actual_rules.is_empty()
        && service.forwarding.is_none()
    {
        forwarding_state = "not_required".into();
    }

    let has_forwarding = service.forwarding.is_some();
    let enabled = service
        .forwarding
        .as_ref()
        .is_some_and(|value| value.enabled);
    ServiceView {
        id: service.id.clone(),
        name: service.name.clone(),
        category: service.category,
        category_detail: service.identity.distribution.clone(),
        bindings,
        network_exposed,
        external,
        runtime_state,
        forwarding_state,
        process,
        forwarding: forwarding_view,
        actual_forwardings,
        diagnostics,
        capabilities: Capabilities {
            can_create_forwarding: !(service.category == ServiceCategory::Windows
                && directly_exposed)
                && actual_rules.is_empty()
                && service
                    .bindings
                    .iter()
                    .any(|binding| binding.protocol == Protocol::Tcp)
                && !has_forwarding,
            can_enable_forwarding: has_forwarding && !enabled,
            can_disable_forwarding: has_forwarding && enabled,
            can_delete_forwarding: has_forwarding,
        },
    }
}

fn candidate_matches_service_port(
    candidate: &DiscoveredEndpoint,
    service: &TrackedService,
) -> bool {
    let wsl_relay_for_service = service.category == ServiceCategory::Wsl
        && candidate.category == ServiceCategory::Windows
        && is_wsl_relay(candidate);
    if candidate.category != service.category && !wsl_relay_for_service {
        return false;
    }
    let same_scope = wsl_relay_for_service
        || service.category == ServiceCategory::Windows
        || candidate.category_detail.as_deref() == service.identity.distribution.as_deref();
    same_scope
        && service
            .bindings
            .iter()
            .any(|binding| binding.port == candidate.port)
}

fn binding_matches_candidate(binding: &ServiceBinding, candidate: &DiscoveredEndpoint) -> bool {
    binding.protocol == candidate.protocol
        && binding.port == candidate.port
        && normalize_address(&binding.address) == normalize_address(&candidate.address)
}

fn same_port_group(left: &DiscoveredEndpoint, right: &DiscoveredEndpoint) -> bool {
    if left.port != right.port {
        return false;
    }
    let same_scope =
        left.category == right.category && left.category_detail == right.category_detail;
    let wsl_relay_pair = (left.category == ServiceCategory::Wsl
        && right.category == ServiceCategory::Windows
        && is_wsl_relay(right))
        || (right.category == ServiceCategory::Wsl
            && left.category == ServiceCategory::Windows
            && is_wsl_relay(left));
    same_scope || wsl_relay_pair
}

fn is_wsl_relay(candidate: &DiscoveredEndpoint) -> bool {
    candidate.process_name.as_deref().is_some_and(|name| {
        name.eq_ignore_ascii_case("wslrelay.exe") || name.eq_ignore_ascii_case("wslrelay")
    })
}

fn candidate_equivalent(left: &DiscoveredEndpoint, right: &DiscoveredEndpoint) -> bool {
    left.category == right.category
        && left.category_detail == right.category_detail
        && left.protocol == right.protocol
        && normalize_address(&left.address) == normalize_address(&right.address)
        && left.port == right.port
        && match (&left.process_path, &right.process_path) {
            (Some(left), Some(right)) => normalize_path(left) == normalize_path(right),
            _ => left.process_name == right.process_name,
        }
}

fn normalize_path(path: &str) -> String {
    path.replace('/', "\\").to_lowercase()
}

fn is_network_listener(address: &str) -> bool {
    address
        .parse::<std::net::IpAddr>()
        .is_ok_and(|address| !address.is_loopback())
}

pub fn run_elevated_helper_if_requested() -> bool {
    portproxy::run_elevated_helper_if_requested()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState {
            candidates: Mutex::new(HashMap::new()),
            operation_lock: Mutex::new(()),
        })
        .invoke_handler(tauri::generate_handler![
            get_dashboard_snapshot,
            discover_candidates,
            create_service,
            open_service_process_directory,
            open_candidate_process_directory,
            remove_service,
            create_forwarding,
            set_forwarding_enabled,
            delete_forwarding,
            create_port_mapping,
            create_port_mappings,
            delete_port_mapping,
            set_port_mapping_enabled,
            start_ip_helper_service,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Portman");
}

#[cfg(test)]
mod mapping_tests {
    use super::{
        is_portproxy_listener, mapping_source_address_matches, mapping_source_endpoint_available,
        PortProxyRule,
    };
    use crate::models::{DiscoveredEndpoint, PortProxyType, Protocol, ServiceCategory};

    #[test]
    fn source_address_accepts_exact_and_wildcard_listeners() {
        assert!(mapping_source_address_matches("127.0.0.1", "127.0.0.1"));
        assert!(mapping_source_address_matches("127.0.0.1", "0.0.0.0"));
        assert!(mapping_source_address_matches("0.0.0.0", "192.168.1.20"));
        assert!(mapping_source_address_matches("::1", "::"));
    }

    #[test]
    fn source_address_rejects_different_specific_addresses_and_families() {
        assert!(!mapping_source_address_matches("127.0.0.1", "192.168.1.20"));
        assert!(!mapping_source_address_matches("127.0.0.1", "::"));
    }

    #[test]
    fn portproxy_listener_is_not_treated_as_a_service_source() {
        let rules = vec![PortProxyRule {
            proxy_type: PortProxyType::V4ToV4,
            listen_address: "0.0.0.0".into(),
            listen_port: 40_001,
            connect_address: "127.0.0.1".into(),
            connect_port: 40_001,
        }];
        assert!(is_portproxy_listener("0.0.0.0", 40_001, &rules));
        assert!(!is_portproxy_listener("127.0.0.1", 40_001, &rules));
        assert!(!is_portproxy_listener("0.0.0.0", 40_002, &rules));
    }

    #[test]
    fn wslrelay_marks_private_wsl_mapping_source_available() {
        let rule = PortProxyRule {
            proxy_type: PortProxyType::V4ToV4,
            listen_address: "0.0.0.0".into(),
            listen_port: 36_500,
            connect_address: "192.168.15.126".into(),
            connect_port: 36_500,
        };
        let endpoints = vec![
            discovered_endpoint("0.0.0.0", 36_500, "svchost.exe"),
            discovered_endpoint("::1", 36_500, "wslrelay.exe"),
        ];
        assert!(mapping_source_endpoint_available(
            &rule.connect_address,
            rule.connect_port,
            &endpoints,
            std::slice::from_ref(&rule),
        ));
    }

    #[test]
    fn ip_helper_alone_does_not_mark_loopback_mapping_source_available() {
        let rule = PortProxyRule {
            proxy_type: PortProxyType::V4ToV4,
            listen_address: "0.0.0.0".into(),
            listen_port: 40_001,
            connect_address: "127.0.0.1".into(),
            connect_port: 40_001,
        };
        let endpoints = vec![discovered_endpoint("0.0.0.0", 40_001, "svchost.exe")];
        assert!(!mapping_source_endpoint_available(
            &rule.connect_address,
            rule.connect_port,
            &endpoints,
            std::slice::from_ref(&rule),
        ));
    }

    fn discovered_endpoint(address: &str, port: u16, process_name: &str) -> DiscoveredEndpoint {
        DiscoveredEndpoint {
            candidate_token: String::new(),
            category: ServiceCategory::Windows,
            category_detail: Some(process_name.into()),
            protocol: Protocol::Tcp,
            address: address.into(),
            port,
            pid: None,
            process_name: Some(process_name.into()),
            process_path: None,
            port_proxy_relations: Vec::new(),
        }
    }
}
