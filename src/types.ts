export type Category = 'windows' | 'wsl'
export type Protocol = 'tcp' | 'udp'
export type ProxyType = 'v4tov4' | 'v4tov6' | 'v6tov4' | 'v6tov6'
export type RuntimeState = 'running' | 'stopped' | 'conflict' | 'unknown'
export type ForwardingState = 'unconfigured' | 'not_required' | 'disabled' | 'active' | 'repair_required' | 'conflict' | 'error'

export interface Endpoint {
  address: string
  port: number
}

export interface PortMapping {
  proxyType: ProxyType
  listenAddress: string
  externalPort: number
  connectAddress: string
  targetPort: number
  enabled: boolean
  sourceAvailable: boolean
}

export interface ServiceView {
  id: string
  name: string
  category: Category
  categoryDetail?: string
  bindings: Array<Endpoint & { protocol: Protocol; active: boolean }>
  networkExposed: boolean
  external?: Endpoint
  runtimeState: RuntimeState
  forwardingState: ForwardingState
  process?: { pid?: number; name?: string; path?: string }
  forwarding?: {
    proxyType: ProxyType
    listenAddress: string
    externalPort: number
    targetAddress: string
    targetPort: number
    connectAddress?: string
    enabled: boolean
  }
  actualForwardings: PortMapping[]
  diagnostics: Array<{ code: string; message: string }>
  capabilities: {
    canCreateForwarding: boolean
    canEnableForwarding: boolean
    canDisableForwarding: boolean
    canDeleteForwarding: boolean
  }
}

export interface DashboardSnapshot {
  generatedAt: string
  services: ServiceView[]
  portMappings: PortMapping[]
  system: { ipHelperState: 'running' | 'stopped' | 'unknown' }
  warnings: Array<{ code: string; message: string }>
  configPath: string
}

export interface Candidate {
  candidateToken: string
  category: Category
  categoryDetail?: string
  protocol: Protocol
  address: string
  port: number
  pid?: number
  processName?: string
  processPath?: string
  portProxyRelations: Array<{ role: 'source' | 'target'; otherPort: number }>
}

export interface DiscoveryResult {
  candidates: Candidate[]
  warnings: Array<{ code: string; message: string }>
}

export interface ApiError {
  code?: string
  message?: string
}
