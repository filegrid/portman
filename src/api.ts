import { invoke } from '@tauri-apps/api/core'
import type { DashboardSnapshot, DiscoveryResult, PortMapping, ProxyType } from './types'

export const api = {
  snapshot: () => invoke<DashboardSnapshot>('get_dashboard_snapshot'),
  discover: () => invoke<DiscoveryResult>('discover_candidates'),
  createService: (candidateTokens: string[], name: string) =>
    invoke<{ message: string }>('create_service', { request: { candidateTokens, name } }),
  openServiceProcessDirectory: (serviceId: string) =>
    invoke<{ message: string }>('open_service_process_directory', { request: { serviceId } }),
  openCandidateProcessDirectory: (candidateToken: string) =>
    invoke<{ message: string }>('open_candidate_process_directory', { request: { candidateToken } }),
  removeService: (serviceId: string) =>
    invoke<{ message: string }>('remove_service', { request: { serviceId } }),
  createForwarding: (request: {
    serviceId: string
    proxyType: ProxyType
    listenAddress: string
    externalPort: number
    targetAddress: string
    targetPort: number
    connectAddress?: string
    enabled: boolean
  }) => invoke<{ message: string }>('create_forwarding', { request }),
  setForwardingEnabled: (serviceId: string, enabled: boolean) =>
    invoke<{ message: string }>('set_forwarding_enabled', { request: { serviceId, enabled } }),
  deleteForwarding: (serviceId: string) =>
    invoke<{ message: string }>('delete_forwarding', { request: { serviceId } }),
  createPortMapping: (request: PortMapping) =>
    invoke<{ message: string }>('create_port_mapping', { request }),
  createPortMappings: (mappings: PortMapping[]) =>
    invoke<{ message: string }>('create_port_mappings', { request: { mappings } }),
  deletePortMapping: (request: PortMapping) =>
    invoke<{ message: string }>('delete_port_mapping', { request }),
  setPortMappingEnabled: (mapping: PortMapping, enabled: boolean) =>
    invoke<{ message: string }>('set_port_mapping_enabled', { request: { ...mapping, enabled } }),
  startIpHelper: () => invoke<{ message: string }>('start_ip_helper_service'),
}
