use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigFile {
    pub version: u32,
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub services: Vec<TrackedService>,
    #[serde(default)]
    pub port_mappings: Vec<PortMappingConfig>,
}

impl Default for ConfigFile {
    fn default() -> Self {
        Self {
            version: 1,
            settings: Settings::default(),
            services: Vec::new(),
            port_mappings: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "default_external_address")]
    pub default_external_address: String,
    #[serde(default = "default_proxy_type")]
    pub default_proxy_type: PortProxyType,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            default_external_address: default_external_address(),
            default_proxy_type: default_proxy_type(),
        }
    }
}

fn default_external_address() -> String {
    "127.0.0.1".to_string()
}

fn default_proxy_type() -> PortProxyType {
    PortProxyType::V4ToV4
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrackedService {
    pub id: String,
    pub name: String,
    pub category: ServiceCategory,
    pub bindings: Vec<ServiceBinding>,
    #[serde(default)]
    pub identity: ServiceIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarding: Option<ForwardingConfig>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ServiceIdentity {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub process_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServiceBinding {
    pub protocol: Protocol,
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ForwardingConfig {
    #[serde(default = "default_proxy_type")]
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub target_address: String,
    pub target_port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connect_address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_applied_connect_address: Option<String>,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PortMappingConfig {
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub connect_address: String,
    pub target_port: u16,
    #[serde(default)]
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceCategory {
    Windows,
    Wsl,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Protocol {
    Tcp,
    Udp,
}

impl Protocol {
    pub fn as_sort_key(self) -> u8 {
        match self {
            Self::Tcp => 0,
            Self::Udp => 1,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortProxyType {
    #[serde(rename = "v4tov4")]
    V4ToV4,
    #[serde(rename = "v4tov6")]
    V4ToV6,
    #[serde(rename = "v6tov4")]
    V6ToV4,
    #[serde(rename = "v6tov6")]
    V6ToV6,
}

impl PortProxyType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::V4ToV4 => "v4tov4",
            Self::V4ToV6 => "v4tov6",
            Self::V6ToV4 => "v6tov4",
            Self::V6ToV6 => "v6tov6",
        }
    }

    pub fn listens_ipv6(self) -> bool {
        matches!(self, Self::V6ToV4 | Self::V6ToV6)
    }

    pub fn connects_ipv6(self) -> bool {
        matches!(self, Self::V4ToV6 | Self::V6ToV6)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredEndpoint {
    pub candidate_token: String,
    pub category: ServiceCategory,
    pub category_detail: Option<String>,
    pub protocol: Protocol,
    pub address: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process_name: Option<String>,
    pub process_path: Option<String>,
    pub port_proxy_relations: Vec<PortProxyRelation>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortProxyRelation {
    pub role: String,
    pub other_port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryResult {
    pub candidates: Vec<DiscoveredEndpoint>,
    pub warnings: Vec<AppWarning>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardSnapshot {
    pub generated_at: String,
    pub services: Vec<ServiceView>,
    pub port_mappings: Vec<ActualForwardingView>,
    pub system: SystemView,
    pub warnings: Vec<AppWarning>,
    pub config_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemView {
    pub ip_helper_state: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceView {
    pub id: String,
    pub name: String,
    pub category: ServiceCategory,
    pub category_detail: Option<String>,
    pub bindings: Vec<BindingView>,
    pub network_exposed: bool,
    pub external: Option<EndpointView>,
    pub runtime_state: String,
    pub forwarding_state: String,
    pub process: Option<ProcessView>,
    pub forwarding: Option<ForwardingView>,
    pub actual_forwardings: Vec<ActualForwardingView>,
    pub diagnostics: Vec<Diagnostic>,
    pub capabilities: Capabilities,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointView {
    pub address: String,
    pub port: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingView {
    pub protocol: Protocol,
    pub address: String,
    pub port: u16,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessView {
    pub pid: Option<u32>,
    pub name: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardingView {
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub target_address: String,
    pub target_port: u16,
    pub connect_address: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActualForwardingView {
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub connect_address: String,
    pub target_port: u16,
    pub enabled: bool,
    pub source_available: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub can_create_forwarding: bool,
    pub can_enable_forwarding: bool,
    pub can_disable_forwarding: bool,
    pub can_delete_forwarding: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diagnostic {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWarning {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServiceRequest {
    pub candidate_tokens: Vec<String>,
    pub name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceIdRequest {
    pub service_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateTokenRequest {
    pub candidate_token: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateForwardingRequest {
    pub service_id: String,
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub target_address: String,
    pub target_port: u16,
    pub connect_address: Option<String>,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetForwardingEnabledRequest {
    pub service_id: String,
    pub enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMappingRequest {
    pub proxy_type: PortProxyType,
    pub listen_address: String,
    pub external_port: u16,
    pub connect_address: String,
    pub target_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePortMappingsRequest {
    pub mappings: Vec<PortMappingRequest>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetPortMappingEnabledRequest {
    #[serde(flatten)]
    pub mapping: PortMappingRequest,
    pub enabled: bool,
}
