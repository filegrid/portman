import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  CircleOff,
  Cog,
  FolderOpen,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react'
import { api } from './api'
import type { ApiError, Candidate, DashboardSnapshot, DiscoveryResult, PortMapping, ProxyType, ServiceView } from './types'

type Language = 'en' | 'zh'

function l(language: Language, english: string, chinese: string) {
  return language === 'zh' ? chinese : english
}

const emptySnapshot: DashboardSnapshot = {
  generatedAt: '',
  services: [],
  portMappings: [],
  system: { ipHelperState: 'unknown' },
  warnings: [],
  configPath: '%USERPROFILE%\\.portman\\config.yaml',
}

function errorMessage(error: unknown, language: Language) {
  if (typeof error === 'string') return error
  const apiError = error as ApiError
  if (language === 'zh') return apiError?.message || String(error)
  const messages: Record<string, string> = {
    CANDIDATE_STALE: 'The listener changed. Refresh and try again.',
    SERVICE_EXISTS: 'This service is already tracked.',
    SERVICE_NOT_FOUND: 'The service no longer exists.',
    PROCESS_PATH_UNAVAILABLE: 'The executable path is unavailable.',
    PORT_CONFLICT: 'The external listening endpoint is already in use.',
    FORWARDING_EXISTS: 'This service already has a forwarding configuration.',
    IP_HELPER_STOPPED: 'IP Helper is not running.',
    ELEVATION_CANCELLED: 'Administrator approval was cancelled.',
    WINDOWS_DISCOVERY_FAILED: 'Windows listener discovery failed.',
    WSL_DISCOVERY_FAILED: 'WSL listener discovery failed.',
    WSL_UNAVAILABLE: 'WSL is unavailable.',
    CONFIG_INVALID: 'The Portman configuration is invalid.',
    FORWARDING_MISSING: 'The configured forwarding rule is missing from Windows.',
    FORWARDING_CONFLICT: 'The live Windows forwarding rule differs from the Portman configuration.',
    UNEXPECTED_SYSTEM_RULE: 'A live Windows rule exists while the Portman configuration is disabled.',
    MAPPING_NOT_FOUND: 'This port mapping no longer exists.',
    INVALID_ADDRESS: 'Enter a valid IP address.',
    INVALID_PROXY_TYPE: 'The proxy type does not match the address family.',
    INVALID_PORT: 'Ports must be between 1 and 65535.',
    INVALID_BATCH: 'Enter between 1 and 256 matching source and mapped ports.',
    SOURCE_PORT_UNAVAILABLE: 'The selected source address and port do not have an active TCP listener.',
  }
  return (apiError?.code && messages[apiError.code]) || (apiError?.code ? `Operation failed (${apiError.code}).` : 'Operation failed.')
}

function operationMessage(message: string, language: Language) {
  if (language === 'zh') return message
  const batchWarning = message.match(/^已添加 (\d+) 条端口映射；以下服务源当前没有 TCP 监听：(.+)$/)
  if (batchWarning) return `${batchWarning[1]} port mappings added. No active TCP listener was found at: ${batchWarning[2]}.`
  const addWarning = message.match(/^端口映射已添加；服务源 (.+) 当前没有 TCP 监听$/)
  if (addWarning) return `Port mapping added. No active TCP listener was found at ${addWarning[1]}.`
  const enableWarning = message.match(/^端口映射已启用；服务源 (.+) 当前没有 TCP 监听$/)
  if (enableWarning) return `Port mapping enabled. No active TCP listener was found at ${enableWarning[1]}.`
  const batch = message.match(/^已添加 (\d+) 条端口映射$/)
  if (batch) return `${batch[1]} port mappings added.`
  const messages: Record<string, string> = {
    '服务已加入关注': 'Service added.',
    '已打开进程所在目录': 'Process directory opened.',
    '端口转发已创建并启用': 'Port forwarding created and enabled.',
    '端口转发配置已保存': 'Port forwarding configuration saved.',
    '端口转发已启用': 'Port forwarding enabled.',
    '端口转发已禁用': 'Port forwarding disabled.',
    '端口转发已删除': 'Port forwarding deleted.',
    '已取消关注服务': 'Service removed.',
    'IP Helper 已启动': 'IP Helper started.',
    '端口映射已添加': 'Port mapping added.',
    '端口映射已删除': 'Port mapping deleted.',
    '端口映射已启用': 'Port mapping enabled.',
    '端口映射已禁用': 'Port mapping disabled.',
  }
  return messages[message] || 'Operation completed.'
}

export default function App() {
  const [language, setLanguage] = useState<Language>(() => localStorage.getItem('portman.language') === 'zh' ? 'zh' : 'en')
  const languageRef = useRef(language)
  languageRef.current = language
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'windows' | 'wsl' | 'issues'>('all')
  const [page, setPage] = useState<'services' | 'add'>('services')
  const [view, setView] = useState<'services' | 'mappings'>('services')
  const [forwardingService, setForwardingService] = useState<ServiceView | null>(null)
  const [mappingModal, setMappingModal] = useState(false)
  const [toast, setToast] = useState<{ kind: 'success' | 'warning' | 'error'; message: string } | null>(null)
  const refreshing = useRef(false)

  const refresh = useCallback(async (quiet = false) => {
    if (refreshing.current) return
    refreshing.current = true
    if (!quiet) setLoading(true)
    try {
      setSnapshot(await api.snapshot())
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error, languageRef.current) })
    } finally {
      if (!quiet) setLoading(false)
      refreshing.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    localStorage.setItem('portman.language', language)
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
  }, [language])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const perform = async (operation: () => Promise<{ message: string }>) => {
    setBusy(true)
    try {
      const result = await operation()
      const warning = result.message.includes('当前没有 TCP 监听')
      setToast({ kind: warning ? 'warning' : 'success', message: operationMessage(result.message, language) })
      await refresh(true)
      return true
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error, language) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const openDirectory = async (operation: () => Promise<{ message: string }>) => {
    try {
      const result = await operation()
      setToast({ kind: 'success', message: operationMessage(result.message, language) })
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error, language) })
    }
  }

  const filteredServices = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return snapshot.services.filter((service) => {
      if (filter === 'windows' && service.category !== 'windows') return false
      if (filter === 'wsl' && service.category !== 'wsl') return false
      if (filter === 'issues' && !['conflict', 'unknown'].includes(service.runtimeState) && !['conflict', 'error', 'repair_required'].includes(service.forwardingState)) return false
      if (!needle) return true
      return [
        service.name,
        service.categoryDetail,
        service.process?.name,
        service.process?.path,
        ...service.bindings.flatMap((binding) => [binding.address, String(binding.port), binding.protocol]),
        ...service.actualForwardings.flatMap((mapping) => [mapping.listenAddress, String(mapping.externalPort), mapping.connectAddress, String(mapping.targetPort)]),
      ].some((value) => value?.toLowerCase().includes(needle))
    })
  }, [filter, query, snapshot.services])

  const filteredMappingGroups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const groups = new Map<number, PortMapping[]>()
    for (const mapping of snapshot.portMappings) {
      if (needle && ![
        String(mapping.externalPort),
        mapping.listenAddress,
        mapping.connectAddress,
        String(mapping.targetPort),
        mapping.proxyType,
      ].some((value) => value.toLowerCase().includes(needle))) continue
      groups.set(mapping.externalPort, [...(groups.get(mapping.externalPort) ?? []), mapping])
    }
    return [...groups.entries()]
      .map(([port, mappings]) => ({
        port,
        mappings: mappings.sort((left, right) =>
          left.listenAddress.localeCompare(right.listenAddress)
          || left.proxyType.localeCompare(right.proxyType)),
      }))
      .sort((left, right) => left.port - right.port)
  }, [query, snapshot.portMappings])

  const running = snapshot.services.filter((service) => service.runtimeState === 'running').length
  const forwarded = snapshot.services.filter((service) => service.forwardingState === 'active').length
  const externallyAccessible = snapshot.services.filter((service) => service.networkExposed).length
  const issues = snapshot.services.filter((service) =>
    ['conflict', 'unknown'].includes(service.runtimeState)
    || ['conflict', 'error', 'repair_required'].includes(service.forwardingState),
  ).length
  const effectiveMappings = snapshot.portMappings.filter((mapping) =>
    mapping.enabled && mapping.sourceAvailable && snapshot.system.ipHelperState === 'running').length
  const mappingErrors = snapshot.portMappings.filter((mapping) => !mapping.sourceAvailable).length

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Network size={21} /></div>
          <div><strong>Portman</strong><span>PORT CONTROL</span></div>
        </div>
        <nav>
          <button className={`nav-item ${page === 'services' ? 'active' : ''}`} onClick={() => setPage('services')}><Server size={18} /><span>服务</span><em>{snapshot.services.length}</em></button>
          <button className="nav-item" disabled><Cog size={18} /><span>设置</span><small>即将推出</small></button>
        </nav>
        <div className="sidebar-foot">
          <div className={`system-dot ${snapshot.system.ipHelperState}`} />
          <div>
            <span>IP Helper</span>
            <strong>{snapshot.system.ipHelperState === 'running' ? '运行中' : snapshot.system.ipHelperState === 'stopped' ? '已停止' : '未知'}</strong>
          </div>
        </div>
      </aside>

      <main className={`main ${page === 'add' ? 'add-main' : ''}`}>
        {page === 'add' ? <AddServicePage language={language} onLanguageChange={setLanguage} busy={busy} onBack={() => setPage('services')} onOpenCandidate={(token) => void openDirectory(() => api.openCandidateProcessDirectory(token))} onCreate={async (candidates, name) => {
          const ok = await perform(() => api.createService(candidates.map((candidate) => candidate.candidateToken), name))
          if (ok) setPage('services')
          return ok
        }} /> : <>
        <header className="topbar">
          <div className="view-switch">
            <button className={view === 'services' ? 'active' : ''} onClick={() => { setView('services'); setQuery('') }}><Server size={17} />{l(language, 'Service Ports', '服务端口')}</button>
            <button className={view === 'mappings' ? 'active' : ''} onClick={() => { setView('mappings'); setQuery('') }}><Network size={17} />{l(language, 'Port Mappings', '端口映射')}</button>
          </div>
          <section className={`stats-grid header-stats ${view === 'mappings' ? 'mapping-stats' : ''}`}>
            {view === 'services' ? <>
              <StatCard icon={<Box size={16} />} label={l(language, 'Tracked', '关注')} value={snapshot.services.length} tone="blue" />
              <StatCard icon={<Activity size={16} />} label={l(language, 'Running', '运行')} value={running} tone="green" />
              <StatCard icon={<ArrowRight size={16} />} label={l(language, 'Forwarded', '转发')} value={forwarded} tone="violet" />
              <StatCard icon={<ShieldAlert size={16} />} label={l(language, 'Network', '对外')} value={externallyAccessible} tone="amber" />
              <StatCard icon={<AlertTriangle size={16} />} label={l(language, 'Issues', '异常')} value={issues} tone="red" />
            </> : <>
              <StatCard icon={<Network size={16} />} label={l(language, 'Rules', '规则')} value={snapshot.portMappings.length} tone="blue" />
              <StatCard icon={<Activity size={16} />} label={l(language, 'Effective', '生效')} value={effectiveMappings} tone="green" />
              <StatCard icon={<AlertTriangle size={16} />} label={l(language, 'Source errors', '源异常')} value={mappingErrors} tone="red" />
            </>}
          </section>
          <div className="header-actions">
            <button className="button ghost" onClick={() => void refresh()} disabled={loading || busy}>
              <RefreshCw size={16} className={loading ? 'spin' : ''} />{l(language, 'Refresh', '刷新')}
            </button>
            {view === 'services'
              ? <button className="button primary" onClick={() => setPage('add')}><Plus size={17} />{l(language, 'Add service', '添加服务')}</button>
              : <button className="button primary" onClick={() => setMappingModal(true)}><Plus size={17} />{l(language, 'Add mapping', '添加端口映射')}</button>}
            <LanguageSwitch language={language} onChange={setLanguage} />
          </div>
        </header>

        {snapshot.system.ipHelperState === 'stopped' && (
          <div className="banner warning">
            <ShieldAlert size={18} />
            <div><strong>{l(language, 'IP Helper is stopped', 'IP Helper 未运行')}</strong><span>{l(language, 'Windows PortProxy rules cannot operate.', 'Windows PortProxy 无法生效。')}</span></div>
            <button onClick={() => void perform(api.startIpHelper)} disabled={busy}>{l(language, 'Start service', '启动服务')}</button>
          </div>
        )}

        {snapshot.warnings.length > 0 && (
          <div className="banner subtle"><AlertTriangle size={17} /><span>{errorMessage(snapshot.warnings[0], language)}</span></div>
        )}

        {view === 'services' ? <section className="service-panel">
          <div className="panel-toolbar">
            <div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l(language, 'Search services, ports, processes, or paths…', '搜索服务、端口、进程或路径…')} /></div>
            <div className="filters">
              {(['all', 'windows', 'wsl', 'issues'] as const).map((value) => (
                <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
                  {{ all: l(language, 'All', '全部'), windows: 'Windows', wsl: 'WSL', issues: l(language, 'Issues', '异常') }[value]}
                </button>
              ))}
            </div>
          </div>

          <div className="service-table">
            <div className="table-head table-row">
              <span>{l(language, 'Service', '服务')}</span><span>{l(language, 'Status', '状态')}</span><span>{l(language, 'Bindings', '服务端点')}</span><span>{l(language, 'External', '外部端点')}</span><span>{l(language, 'Forwarding', '转发')}</span><span>{l(language, 'Actions', '操作')}</span>
            </div>
            {loading && snapshot.services.length === 0 ? (
              <div className="empty"><RefreshCw className="spin" /><strong>{l(language, 'Scanning ports', '正在扫描端口')}</strong><span>{l(language, 'Reading Windows and WSL listeners…', '读取 Windows 与 WSL 监听服务…')}</span></div>
            ) : filteredServices.length === 0 ? (
              <div className="empty"><Network /><strong>{snapshot.services.length ? l(language, 'No matching services', '没有匹配的服务') : l(language, 'No tracked services', '还没有关注服务')}</strong><span>{snapshot.services.length ? l(language, 'Adjust the search or filters.', '调整搜索或筛选条件。') : l(language, 'Add a service from the current listeners.', '从当前监听端口添加第一个服务。')}</span>{!snapshot.services.length && <button className="button primary" onClick={() => setPage('add')}><Plus size={16} />{l(language, 'Add service', '添加服务')}</button>}</div>
            ) : filteredServices.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                language={language}
                busy={busy}
                onCreateForwarding={() => setForwardingService(service)}
                onOpenProcessDirectory={() => void openDirectory(() => api.openServiceProcessDirectory(service.id))}
                onToggle={(enabled) => void perform(() => api.setForwardingEnabled(service.id, enabled))}
                onDeleteForwarding={() => {
                  if (window.confirm(l(language, `Delete the forwarding configuration for ${service.name}?`, `删除 ${service.name} 的端口转发配置？`))) void perform(() => api.deleteForwarding(service.id))
                }}
                onRemove={() => {
                  if (window.confirm(l(language, `Stop tracking ${service.name}? Managed active forwarding will also be removed.`, `取消关注 ${service.name}？启用中的托管转发也会被清理。`))) void perform(() => api.removeService(service.id))
                }}
              />
            ))}
          </div>
        </section> : <PortMappingsPanel
          language={language}
          loading={loading}
          busy={busy}
          query={query}
          onQueryChange={setQuery}
          groups={filteredMappingGroups}
          services={snapshot.services}
          totalMappings={snapshot.portMappings.length}
          onAdd={() => setMappingModal(true)}
          onToggle={(mapping, enabled) => void perform(() => api.setPortMappingEnabled(mapping, enabled))}
          onDelete={(mapping) => {
            const route = `${formatEndpoint(mapping.connectAddress, mapping.targetPort)} → ${formatEndpoint(mapping.listenAddress, mapping.externalPort)}`
            if (window.confirm(l(language, `Delete port mapping ${route}?`, `彻底删除端口映射 ${route}？`))) {
              void perform(() => api.deletePortMapping(mapping))
            }
          }}
        />}
        </>}
      </main>

      {forwardingService && <ForwardingModal language={language} service={forwardingService} busy={busy} onClose={() => setForwardingService(null)} onCreate={async (request) => {
        const ok = await perform(() => api.createForwarding({ serviceId: forwardingService.id, ...request }))
        if (ok) setForwardingService(null)
        return ok
      }} />}

      {mappingModal && <PortMappingModal language={language} services={snapshot.services} existingMappings={snapshot.portMappings} busy={busy} onClose={() => setMappingModal(false)} onCreate={async (mappings) => {
        const ok = await perform(() => api.createPortMappings(mappings))
        if (ok) setMappingModal(false)
        return ok
      }} />}

      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<span>{toast.message}</span><button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}

function PortMappingsPanel({ language, loading, busy, query, onQueryChange, groups, services, totalMappings, onAdd, onToggle, onDelete }: {
  language: Language
  loading: boolean
  busy: boolean
  query: string
  onQueryChange: (value: string) => void
  groups: Array<{ port: number; mappings: PortMapping[] }>
  services: ServiceView[]
  totalMappings: number
  onAdd: () => void
  onToggle: (mapping: PortMapping, enabled: boolean) => void
  onDelete: (mapping: PortMapping) => void
}) {
  return <section className="service-panel mapping-panel">
    <div className="panel-toolbar">
      <div className="search"><Search size={16} /><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={l(language, 'Search mapping ports, addresses, or types…', '搜索映射端口、地址或类型…')} /></div>
    </div>
    <div className="service-table mapping-table">
      <div className="table-head table-row mapping-table-row">
        <span>{l(language, 'Port', '映射端口')}</span>
        <span>{l(language, 'Service', '服务信息')}</span>
        <span>{l(language, 'Source', '服务源')}</span>
        <span>{l(language, 'Mapped endpoint', '映射目标')}</span>
        <span>{l(language, 'Type / access', '类型 / 访问')}</span>
        <span>{l(language, 'Actions', '操作')}</span>
      </div>
      {loading && totalMappings === 0 ? (
        <div className="empty"><RefreshCw className="spin" /><strong>{l(language, 'Reading port mappings', '正在读取端口映射')}</strong><span>{l(language, 'Reading live Windows PortProxy rules…', '正在读取 Windows PortProxy 实际规则…')}</span></div>
      ) : groups.length === 0 ? (
        <div className="empty"><Network /><strong>{totalMappings ? l(language, 'No matching mappings', '没有匹配的端口映射') : l(language, 'No port mappings', '暂无端口映射')}</strong><span>{totalMappings ? l(language, 'Adjust the search.', '调整搜索条件。') : l(language, 'Add a Windows PortProxy rule directly.', '直接添加一条 Windows PortProxy 规则。')}</span>{!totalMappings && <button className="button primary" onClick={onAdd}><Plus size={16} />{l(language, 'Add mapping', '添加端口映射')}</button>}</div>
      ) : groups.map((group) => <div className="table-row service-row mapping-table-row" key={group.port}>
        <strong className="mapping-port-number">{group.port}</strong>
        <div className="mapping-stack">{group.mappings.map((mapping) => {
          const service = findMappingService(mapping, services)
          const serviceType = service?.category === 'wsl' ? ubuntuServiceType(mapping.targetPort, service.process?.name, language) : ''
          return <div className={`mapping-service-info ${mapping.enabled ? '' : 'inactive'}`} key={mappingKey(mapping)}><strong>{service?.name || l(language, 'Untracked service', '未关注服务')}</strong><span>{service ? service.category === 'wsl' ? `WSL · ${service.categoryDetail} · ${serviceType}` : service.process?.name || 'Windows' : l(language, 'No matching service port', '未匹配到服务端口')}</span></div>
        })}</div>
        <div className="mapping-stack">{group.mappings.map((mapping) => <code className={!mapping.sourceAvailable ? 'source-error' : mapping.enabled ? '' : 'inactive'} title={!mapping.sourceAvailable ? l(language, 'No active TCP listener was found at this source endpoint.', '该服务源端点当前没有 TCP 服务监听。') : undefined} key={mappingKey(mapping)}>{formatEndpoint(mapping.connectAddress, mapping.targetPort)}</code>)}</div>
        <div className="mapping-stack">{group.mappings.map((mapping) => <code className={mapping.enabled ? '' : 'inactive'} key={mappingKey(mapping)}>{formatEndpoint(mapping.listenAddress, mapping.externalPort)}</code>)}</div>
        <div className="mapping-stack">{group.mappings.map((mapping) => <div className="mapping-rule-meta" key={mappingKey(mapping)}><span className="proxy-type">{mapping.proxyType}</span>{!mapping.sourceAvailable ? <span className="mapping-source-error"><AlertTriangle size={11} />{l(language, 'Source unavailable', '源端口异常')}</span> : !mapping.enabled ? <span className="mapping-disabled-badge">{l(language, 'Disabled', '未生效')}</span> : isNetworkExposed(mapping.listenAddress) ? <span className="exposure-badge"><ShieldAlert size={11} />{l(language, 'Network', '对外开放')}</span> : <span className="local-badge">{l(language, 'Local', '仅本机')}</span>}</div>)}</div>
        <div className="mapping-action-stack">{group.mappings.map((mapping) => <div className="mapping-actions-line" key={mappingKey(mapping)}><button className={`mapping-switch ${mapping.enabled ? 'active' : ''}`} role="switch" aria-checked={mapping.enabled} title={mapping.enabled ? l(language, 'Disable mapping', '禁用端口映射') : l(language, 'Enable mapping', '启用端口映射')} disabled={busy} onClick={() => onToggle(mapping, !mapping.enabled)}><span /></button><button className="icon-button danger-button" title={l(language, 'Delete mapping', '彻底删除端口映射')} disabled={busy} onClick={() => onDelete(mapping)}><Trash2 size={14} /></button></div>)}</div>
      </div>)}
    </div>
    <footer className="panel-footer"><span>{l(language, 'Live Windows PortProxy rules', 'Windows PortProxy 实际规则')}</span><span className="spacer" /><span>{l(language, 'Grouped and sorted by listening port', '按监听端口合并并排序')}</span></footer>
  </section>
}

function mappingKey(mapping: PortMapping) {
  return `${mapping.proxyType}:${mapping.listenAddress}:${mapping.externalPort}:${mapping.connectAddress}:${mapping.targetPort}`
}

function findMappingService(mapping: PortMapping, services: ServiceView[]) {
  const matches = services.filter((service) =>
    service.runtimeState === 'running'
    && service.bindings.some((binding) => binding.protocol === 'tcp' && binding.active && binding.port === mapping.targetPort))
  return matches.find((service) => service.bindings.some((binding) =>
    binding.protocol === 'tcp'
    && binding.active
    && binding.port === mapping.targetPort
    && binding.address.toLowerCase() === mapping.connectAddress.toLowerCase()))
    ?? matches[0]
}

function formatEndpoint(address: string, port: number) {
  return `${address.includes(':') ? `[${address}]` : address}:${port}`
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>
}

function LanguageSwitch({ language, onChange }: { language: Language; onChange: (language: Language) => void }) {
  return <div className="language-switch"><button className={language === 'en' ? 'active' : ''} onClick={() => onChange('en')}>EN</button><button className={language === 'zh' ? 'active' : ''} onClick={() => onChange('zh')}>中文</button></div>
}

function ServiceRow({ service, language, busy, onCreateForwarding, onOpenProcessDirectory, onToggle, onDeleteForwarding, onRemove }: {
  service: ServiceView
  language: Language
  busy: boolean
  onCreateForwarding: () => void
  onOpenProcessDirectory: () => void
  onToggle: (enabled: boolean) => void
  onDeleteForwarding: () => void
  onRemove: () => void
}) {
  const [menu, setMenu] = useState(false)
  const servicePort = service.bindings.find((binding) => binding.active)?.port ?? service.bindings[0]?.port ?? 0
  const serviceType = service.category === 'wsl' ? ubuntuServiceType(servicePort, service.process?.name, language) : ''
  return <div className="table-row service-row" onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <div className="service-cell">
      <div className={`service-icon ${service.category}`}><Server size={17} /></div>
      <div className="truncate"><strong>{service.name}</strong><span title={service.process?.path}>{service.category === 'wsl' ? `${service.categoryDetail} · ${serviceType}${service.process?.name ? ` · ${service.process.name}` : ''}` : service.process?.name || l(language, 'Windows service', 'Windows 服务')}{service.process?.pid ? ` · PID ${service.process.pid}` : ''}</span></div>
    </div>
    <div className="service-status-cell"><StatusBadge language={language} kind="runtime" state={service.runtimeState} />{service.networkExposed && <span className="exposure-badge" title={l(language, 'Bound to a non-loopback address and potentially reachable from other networks, subject to firewall and routing.', '绑定到非回环地址，可能被局域网或公网直接访问，实际范围取决于防火墙和路由')}><ShieldAlert size={11} />{l(language, 'Network', '对外监听')}</span>}</div>
    <BindingsCell language={language} bindings={service.bindings} />
    <ActualMappingsCell language={language} mappings={service.actualForwardings} />
    <div className="forward-cell"><StatusBadge language={language} kind="forwarding" state={service.forwardingState} />{service.actualForwardings.length > 0 && <small>{[...new Set(service.actualForwardings.map((mapping) => mapping.proxyType))].join(' · ')}</small>}</div>
    <div className="row-actions">
      {service.capabilities.canCreateForwarding && <button className="compact primary" onClick={onCreateForwarding}>{l(language, 'Configure', '配置转发')}</button>}
      {service.capabilities.canEnableForwarding && <button className="compact" disabled={busy} onClick={() => onToggle(true)}>{l(language, 'Enable', '启用')}</button>}
      {service.capabilities.canDisableForwarding && <button className="compact" disabled={busy} onClick={() => onToggle(false)}>{l(language, 'Disable', '禁用')}</button>}
      <div className="menu-wrap">
        <button className="icon-button" onClick={() => setMenu(!menu)}><ChevronDown size={16} /></button>
        {menu && <div className="context-menu">
          {service.process?.path && <button onClick={() => { setMenu(false); onOpenProcessDirectory() }}><FolderOpen size={15} />{l(language, 'Open process directory', '打开进程目录')}</button>}
          {service.capabilities.canDeleteForwarding && <button onClick={() => { setMenu(false); onDeleteForwarding() }}><CircleOff size={15} />{l(language, 'Delete forwarding', '删除转发')}</button>}
          <button className="danger" onClick={() => { setMenu(false); onRemove() }}><Trash2 size={15} />{l(language, 'Stop tracking', '取消关注')}</button>
        </div>}
      </div>
    </div>
    {service.diagnostics.length > 0 && <div className="row-diagnostic" title={service.diagnostics.map((item) => errorMessage(item, language)).join('\n')}><AlertTriangle size={13} />{errorMessage(service.diagnostics[0], language)}</div>}
  </div>
}

function ActualMappingsCell({ mappings, language }: { mappings: ServiceView['actualForwardings']; language: Language }) {
  if (!mappings.length) return <div className="endpoint empty-value">{l(language, 'No mapping', '无实际映射')}</div>
  return <div className="binding-stack actual-mappings" title={mappings.map((mapping) => `${mapping.listenAddress}:${mapping.externalPort} → ${mapping.connectAddress}:${mapping.targetPort}`).join('\n')}>
    {mappings.slice(0, 2).map((mapping) => <div className="binding-line" key={`${mapping.proxyType}-${mapping.listenAddress}-${mapping.externalPort}`}><code>{mapping.listenAddress.includes(':') ? `[${mapping.listenAddress}]` : mapping.listenAddress}<b>:{mapping.externalPort}</b></code></div>)}
    {mappings.length > 2 && <small>{l(language, `${mappings.length - 2} more mappings`, `另有 ${mappings.length - 2} 条实际映射`)}</small>}
  </div>
}

function BindingsCell({ bindings, language }: { bindings: ServiceView['bindings']; language: Language }) {
  const shown = bindings.slice(0, 3)
  return <div className="binding-stack">
    {shown.map((binding) => <div className={`binding-line ${binding.active ? '' : 'inactive'}`} key={`${binding.protocol}-${binding.address}-${binding.port}`}>
      <span className={`protocol ${binding.protocol}`}>{binding.protocol.toUpperCase()}</span>
      <code>{binding.address.includes(':') ? `[${binding.address}]` : binding.address}<b>:{binding.port}</b></code>
    </div>)}
    {bindings.length > shown.length && <small>{l(language, `${bindings.length - shown.length} more bindings`, `另有 ${bindings.length - shown.length} 个绑定`)}</small>}
  </div>
}

function StatusBadge({ language, kind, state }: { language: Language; kind: 'runtime' | 'forwarding'; state: string }) {
  const labels: Record<string, string> = {
    running: l(language, 'Running', '运行中'), stopped: l(language, 'Stopped', '已停止'), conflict: l(language, 'Conflict', '冲突'), unknown: l(language, 'Unknown', '未知'),
    unconfigured: l(language, 'Not configured', '未配置'), not_required: l(language, 'Not required', '无需转发'), disabled: l(language, 'Disabled', '已禁用'), active: l(language, 'Active', '已生效'), repair_required: l(language, 'Repair', '需修复'), error: l(language, 'Error', '错误'),
  }
  return <span className={`status-badge ${state}`}><i />{labels[state] || state}{kind === 'runtime' && state === 'stopped' ? '' : ''}</span>
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal"><div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>{children}</div>
  </div>
}

function PortMappingModal({ language, services, existingMappings, busy, onClose, onCreate }: {
  language: Language
  services: ServiceView[]
  existingMappings: PortMapping[]
  busy: boolean
  onClose: () => void
  onCreate: (mappings: PortMapping[]) => Promise<boolean>
}) {
  const [proxyType, setProxyType] = useState<ProxyType>('v4tov4')
  const [sourceAddress, setSourceAddress] = useState('127.0.0.1')
  const [sourcePortsText, setSourcePortsText] = useState('')
  const [mappedAddress, setMappedAddress] = useState('0.0.0.0')
  const [mappedPortsText, setMappedPortsText] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const sourcePortOptions = useMemo(() => {
    const ports = new Map<number, string[]>()
    for (const service of services) {
      const alreadyMapped = existingMappings.some((mapping) =>
        service.bindings.some((binding) => binding.protocol === 'tcp' && binding.active && binding.port === mapping.targetPort))
      if (service.networkExposed || alreadyMapped) continue
      for (const binding of service.bindings.filter((item) => item.protocol === 'tcp' && item.active)) {
        const detail = service.category === 'wsl'
          ? `${service.name} · WSL ${service.categoryDetail ?? ''}`
          : `${service.name} · ${service.process?.name || 'Windows'}`
        ports.set(binding.port, [...new Set([...(ports.get(binding.port) ?? []), detail])])
      }
    }
    return [...ports.entries()].sort(([left], [right]) => left - right)
  }, [existingMappings, services])
  const sourcePorts = parsePortExpression(sourcePortsText)
  const mappedPorts = parsePortExpression(mappedPortsText)
  const selectedSourceServices = sourcePorts?.length === 1
    ? services.filter((service) =>
      !service.networkExposed
      && service.runtimeState === 'running'
      && !existingMappings.some((mapping) => service.bindings.some((binding) => binding.protocol === 'tcp' && binding.active && binding.port === mapping.targetPort))
      && service.bindings.some((binding) => binding.protocol === 'tcp' && binding.active && binding.port === sourcePorts[0]))
    : []

  const changeProxyType = (value: ProxyType) => {
    setProxyType(value)
    setSourceAddress(value.endsWith('v6') ? '::1' : '127.0.0.1')
    setMappedAddress(value.startsWith('v6') ? '::' : '0.0.0.0')
  }
  const valid = !!sourcePorts?.length
    && !!mappedPorts?.length
    && sourcePorts.length === mappedPorts.length
    && sourcePorts.length <= 256
    && sourceAddress.trim().length > 0
    && mappedAddress.trim().length > 0

  return <Modal title={l(language, 'Add port mapping', '添加端口映射')} subtitle={l(language, 'Map one or more service source ports to Windows listening ports. The default type is v4tov4.', '将一个或多个服务源端口映射为 Windows 监听端口；默认类型为 v4tov4。')} onClose={onClose}>
    <div className="modal-body form-body mapping-modal-body">
      <div className="route-preview"><div><span>{l(language, 'Service source', '服务源')}</span><strong>{sourceAddress || '—'}:{sourcePortsText || '—'}</strong></div><ArrowRight /><div><span>{l(language, 'Mapped target', '映射目标')}</span><strong>{mappedAddress || '—'}:{mappedPortsText || '—'}</strong></div></div>
      <div className="form-grid mapping-form-grid">
        <label>{l(language, 'Source address', '源地址')}<input list="mapping-source-addresses" value={sourceAddress} onChange={(event) => setSourceAddress(event.target.value)} placeholder={proxyType.endsWith('v6') ? '::1' : '127.0.0.1'} /><datalist id="mapping-source-addresses"><option value="127.0.0.1" /><option value="0.0.0.0" /></datalist></label>
        <label>{l(language, 'Source ports', '源端口')} <span>{l(language, 'Choose a service port or enter a list/range', '可下拉选择服务端口，也可输入列表或区间')}</span><input autoFocus list="mapping-source-ports" value={sourcePortsText} onChange={(event) => { setSourcePortsText(event.target.value); if (!mappedPortsText) setMappedPortsText(event.target.value) }} placeholder="80,443,8000-8005" /><datalist id="mapping-source-ports">{sourcePortOptions.map(([port, details]) => <option value={port} label={details.join(' / ')} key={port} />)}</datalist></label>
        <label>{l(language, 'Target address', '目标地址')}<input list="mapping-target-addresses" value={mappedAddress} onChange={(event) => setMappedAddress(event.target.value)} placeholder={proxyType.startsWith('v6') ? '::' : '0.0.0.0'} /><datalist id="mapping-target-addresses"><option value="0.0.0.0" /><option value="127.0.0.1" /></datalist></label>
        <label>{l(language, 'Target ports', '目标端口')} <span>{l(language, 'Must contain the same number of ports', '数量必须与源端口一致')}</span><input value={mappedPortsText} onChange={(event) => setMappedPortsText(event.target.value)} placeholder="80,443,8000-8005" /></label>
      </div>
      {selectedSourceServices.length > 0 && <div className="selected-service-info"><Server size={16} /><div><strong>{selectedSourceServices.map((service) => service.name).join(' / ')}</strong><span>{selectedSourceServices.map((service) => service.category === 'wsl' ? `WSL · ${service.categoryDetail}` : service.process?.name || 'Windows').join(' / ')}</span></div></div>}
      {sourcePorts && mappedPorts && sourcePorts.length !== mappedPorts.length && <div className="inline-form-error"><AlertTriangle size={14} />{l(language, 'Source and target port counts must match.', '源端口与目标端口的数量必须一致。')}</div>}
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={16} />{l(language, 'Advanced options', '高级选项')}<ChevronDown size={15} className={advanced ? 'open' : ''} /></button>
      {advanced && <div className="advanced-panel">
        <label>{l(language, 'Proxy type', '代理类型')}<select value={proxyType} onChange={(event) => changeProxyType(event.target.value as ProxyType)}><option value="v4tov4">v4tov4 {l(language, '(default)', '（默认）')}</option><option value="v4tov6">v4tov6</option><option value="v6tov4">v6tov4</option><option value="v6tov6">v6tov6</option></select></label>
      </div>}
      {isNetworkExposed(mappedAddress) && <div className="security-note mapping-security-note"><ShieldAlert size={15} />{l(language, 'The mapped target listens beyond loopback and may be reachable from other networks, subject to Windows Firewall and routing.', '映射目标并非仅监听回环地址，可能被其他网络访问，实际范围取决于 Windows 防火墙和路由。')}</div>}
      <div className="modal-actions"><button className="button ghost" onClick={onClose}>{l(language, 'Cancel', '取消')}</button><button className="button primary" disabled={busy || !valid} onClick={() => sourcePorts && mappedPorts && void onCreate(sourcePorts.map((sourcePort, index) => ({ proxyType, listenAddress: mappedAddress.trim(), externalPort: mappedPorts[index], connectAddress: sourceAddress.trim(), targetPort: sourcePort, enabled: true, sourceAvailable: true })))}>{busy ? <RefreshCw size={16} className="spin" /> : <Network size={16} />}{l(language, sourcePorts?.length && sourcePorts.length > 1 ? `Add ${sourcePorts.length} mappings` : 'Add mapping', sourcePorts?.length && sourcePorts.length > 1 ? `添加 ${sourcePorts.length} 条映射` : '添加端口映射')}</button></div>
    </div>
  </Modal>
}

function parsePortExpression(value: string): number[] | null {
  const parts = value.trim().split(/[,;\s]+/).filter(Boolean)
  if (!parts.length) return null
  const ports: number[] = []
  const seen = new Set<number>()
  for (const part of parts) {
    const range = part.match(/^(\d+)-(\d+)$/)
    const start = Number(range ? range[1] : part)
    const end = Number(range ? range[2] : part)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end > 65535 || end < start) return null
    for (let port = start; port <= end; port += 1) {
      if (seen.has(port) || ports.length >= 256) return null
      seen.add(port)
      ports.push(port)
    }
  }
  return ports
}

function AddServicePage({ language, onLanguageChange, busy, onBack, onOpenCandidate, onCreate }: { language: Language; onLanguageChange: (language: Language) => void; busy: boolean; onBack: () => void; onOpenCandidate: (token: string) => void; onCreate: (candidates: Candidate[], name: string) => Promise<boolean> }) {
  const languageRef = useRef(language)
  languageRef.current = language
  const [result, setResult] = useState<DiscoveryResult | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [showTcp, setShowTcp] = useState(true)
  const [showUdp, setShowUdp] = useState(false)
  const [showWindowsSystemServices, setShowWindowsSystemServices] = useState(false)
  const [selectedKey, setSelectedKey] = useState('')
  const [name, setName] = useState('')
  const [contextCandidate, setContextCandidate] = useState<{ candidate: Candidate; x: number; y: number } | null>(null)

  const load = useCallback(async () => {
    setError('')
    setResult(null)
    try { setResult(await api.discover()) } catch (value) { setError(errorMessage(value, languageRef.current)) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!contextCandidate) return
    const close = () => setContextCandidate(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [contextCandidate])

  const sourceGroups = useMemo(() => {
    const candidates = result?.candidates ?? []
    const groups = new Map<string, Candidate[]>()
    for (const candidate of candidates) {
      const matchingWsl = candidate.category === 'windows' && isWslRelay(candidate)
        ? candidates.find((item) => item.category === 'wsl' && item.port === candidate.port)
        : undefined
      const key = portGroupKey(matchingWsl ?? candidate)
      groups.set(key, [...(groups.get(key) ?? []), candidate])
    }
    return [...groups.entries()].map(([key, candidates]) => ({
      key,
      candidates: candidates.sort((left, right) => Number(right.category === 'wsl') - Number(left.category === 'wsl') || left.protocol.localeCompare(right.protocol)),
      port: candidates[0].port,
    })).filter(({ candidates }) => candidates.some((candidate) => candidateVisible(candidate, showTcp, showUdp, showWindowsSystemServices)))
      .filter(({ candidates }) => {
      const needle = query.toLowerCase()
      return !needle || candidates.some((candidate) => [candidate.processName, candidate.processPath, candidate.categoryDetail, candidate.address, String(candidate.port)].some((value) => value?.toLowerCase().includes(needle)))
    }).sort((left, right) => left.port - right.port)
  }, [query, result, showTcp, showUdp, showWindowsSystemServices])
  const selected = sourceGroups.find((group) => group.key === selectedKey)

  return <div className="add-page">
    <header className="add-page-head">
      <div className="add-title"><button className="page-back" onClick={onBack}><ArrowLeft size={17} />{l(language, 'Back', '返回')}</button><h1>{l(language, 'Add service', '添加服务')}</h1></div>
      <div className="candidate-toolbar add-header-tools">
        <div className="search modal-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={l(language, 'Search ports, processes, or WSL distributions…', '搜索端口、进程或 WSL 发行版…')} /><button onClick={() => void load()}><RefreshCw size={15} /></button></div>
        <div className="filters protocol-filters">
          <button className={showTcp ? 'active' : ''} onClick={() => setShowTcp(!showTcp)}>TCP</button>
          <button className={showUdp ? 'active' : ''} onClick={() => setShowUdp(!showUdp)}>UDP</button>
          <button className={showWindowsSystemServices ? 'active' : ''} onClick={() => setShowWindowsSystemServices(!showWindowsSystemServices)}>{l(language, 'System services', '系统服务')}</button>
        </div>
        <LanguageSwitch language={language} onChange={onLanguageChange} />
      </div>
    </header>
    <section className="service-panel add-panel"><div className="add-panel-body">
      {error ? <div className="inline-error"><AlertTriangle size={16} />{error}<button onClick={() => void load()}>{l(language, 'Retry', '重试')}</button></div> : !result ? <div className="modal-loading"><RefreshCw className="spin" />{l(language, 'Discovering listeners…', '正在发现监听服务…')}</div> : (
        <div className="source-list">
          {sourceGroups.length === 0 && <div className="modal-loading">{l(language, 'No listeners available to add', '没有可添加的监听服务')}</div>}
          {sourceGroups.map((group) => {
            const visibleBindings = group.candidates.filter((item) => candidateVisible(item, showTcp, showUdp, showWindowsSystemServices))
            const candidate = visibleBindings[0] ?? group.candidates[0]
            const relations = [...new Map(group.candidates.flatMap((item) => item.portProxyRelations).map((relation) => [`${relation.role}-${relation.otherPort}`, relation])).values()]
            const isPortProxyListener = relations.some((relation) => relation.role === 'source')
            const exposed = visibleBindings.some((binding) => binding.category === 'windows' && isNetworkExposed(binding.address))
            const purpose = candidate.category === 'windows' ? windowsPortPurpose(candidate.port, candidate.processName, language) : ubuntuServiceType(candidate.port, candidate.processName, language)
            const displayName = candidate.category === 'wsl' ? purpose : candidate.processName || l(language, 'Unknown process', '未知进程')
            return <button key={group.key} className={selectedKey === group.key ? 'source-card selected' : 'source-card'} onContextMenu={(event) => { event.preventDefault(); setContextCandidate({ candidate, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 52) }) }} onClick={() => { setSelectedKey(group.key); setName(isPortProxyListener ? `PortProxy ${candidate.port}` : candidate.category === 'wsl' ? purpose : candidate.processName || l(language, `Port ${candidate.port}`, `端口 ${candidate.port}`)) }}>
              <div className={`service-icon ${candidate.category}`}><Server size={17} /></div>
              <strong className="port-number">{candidate.port}</strong>
              <div className="candidate-main"><strong>{isPortProxyListener ? 'IP Helper' : displayName}</strong><span>{isPortProxyListener ? `${l(language, 'Windows service', 'Windows 服务')} · ${candidate.processName || 'svchost.exe'}` : candidate.category === 'wsl' ? `WSL · ${candidate.categoryDetail}${candidate.processName ? ` · ${candidate.processName}` : ''}` : 'Windows'}{candidate.pid ? ` · PID ${candidate.pid}` : ''}</span></div>
              <div className={`mapping-cell ${relations.length ? 'mapped' : ''}`}><span>{relations.length ? relations.map((relation) => relation.role === 'source' ? l(language, `Mapping entry · target ${relation.otherPort}`, `映射入口 · 目标 ${relation.otherPort}`) : l(language, `Mapping target · entry ${relation.otherPort}`, `映射目标 · 入口 ${relation.otherPort}`)).join(language === 'zh' ? '；' : '; ') : purpose}</span>{exposed && <strong className="exposure-badge" title={l(language, 'Bound to a non-loopback address and potentially reachable from other networks, subject to firewall and routing.', '绑定到非回环地址，可能被局域网或公网直接访问，实际范围取决于防火墙和路由')}><ShieldAlert size={11} />{l(language, 'Network', '对外监听')}</strong>}</div>
              <div className="source-bindings">{visibleBindings.map((binding) => <span className="binding-chip" key={binding.candidateToken}><i className={binding.protocol}>{binding.protocol.toUpperCase()}</i>{binding.address.includes(':') ? `[${binding.address}]` : binding.address}</span>)}</div>
            </button>
          })}
        </div>
      )}
      {selected && <div className="selection-bar"><label>{l(language, 'Service name', '服务名称')}<input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><button className="button ghost" onClick={onBack}>{l(language, 'Cancel', '取消')}</button><button className="button primary" disabled={busy || !name.trim()} onClick={() => void onCreate(selected.candidates, name)}>{l(language, 'Track service', '加入关注')}</button></div>}
    </div></section>
    {contextCandidate && <div className="context-menu candidate-context-menu" style={{ left: contextCandidate.x, top: contextCandidate.y }} onClick={(event) => event.stopPropagation()}>
      <button disabled={!contextCandidate.candidate.processPath} onClick={() => { onOpenCandidate(contextCandidate.candidate.candidateToken); setContextCandidate(null) }}><FolderOpen size={15} />{l(language, 'Open process directory', '打开进程目录')}</button>
    </div>}
  </div>
}

function portGroupKey(candidate: Candidate) {
  const scope = candidate.category === 'wsl' ? `wsl:${candidate.categoryDetail ?? ''}` : 'windows'
  return `${scope}:port:${candidate.port}`
}

function isWslRelay(candidate: Candidate) {
  return candidate.processName?.toLowerCase().replace('.exe', '') === 'wslrelay'
}

function isWindowsSystemService(candidate: Candidate) {
  if (candidate.category !== 'windows') return false
  if (candidate.pid === 4) return true
  const name = candidate.processName?.toLowerCase()
    || candidate.processPath?.split(/[\\/]/).pop()?.toLowerCase()
  return !!name && [
    'system', 'system idle process', 'svchost.exe', 'services.exe', 'lsass.exe',
    'wininit.exe', 'winlogon.exe', 'csrss.exe', 'spoolsv.exe', 'dashost.exe',
  ].includes(name)
}

function candidateVisible(candidate: Candidate, showTcp: boolean, showUdp: boolean, showWindowsSystemServices: boolean) {
  if (isWindowsSystemService(candidate)) return showWindowsSystemServices
  return (candidate.protocol === 'tcp' && showTcp) || (candidate.protocol === 'udp' && showUdp)
}

function isNetworkExposed(address: string) {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  return normalized !== 'localhost'
    && normalized !== '::1'
    && !normalized.startsWith('127.')
}

function windowsPortPurpose(port: number, processName: string | undefined, language: Language) {
  const chinesePurposes: Record<number, string> = {
    20: 'FTP 数据', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
    67: 'DHCP 服务端', 68: 'DHCP 客户端', 80: 'HTTP', 110: 'POP3', 123: 'NTP',
    135: 'Windows RPC', 137: 'NetBIOS 名称', 138: 'NetBIOS 数据报', 139: 'NetBIOS 会话',
    143: 'IMAP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB 文件共享', 465: 'SMTPS',
    587: 'SMTP 提交', 636: 'LDAPS', 1433: 'SQL Server', 1521: 'Oracle', 1883: 'MQTT',
    2049: 'NFS', 2375: 'Docker API', 3000: 'Web 开发服务', 3306: 'MySQL', 3389: '远程桌面',
    5353: 'mDNS', 5355: 'LLMNR', 5357: 'WSDAPI', 5432: 'PostgreSQL', 5672: 'AMQP',
    5985: 'WinRM HTTP', 5986: 'WinRM HTTPS', 6379: 'Redis', 8080: 'HTTP 备用端口',
    8443: 'HTTPS 备用端口', 27017: 'MongoDB',
  }
  const englishPurposes: Record<number, string> = {
    20: 'FTP data', 21: 'FTP', 22: 'SSH', 23: 'Telnet', 25: 'SMTP', 53: 'DNS',
    67: 'DHCP server', 68: 'DHCP client', 80: 'HTTP', 110: 'POP3', 123: 'NTP',
    135: 'Windows RPC', 137: 'NetBIOS name', 138: 'NetBIOS datagram', 139: 'NetBIOS session',
    143: 'IMAP', 389: 'LDAP', 443: 'HTTPS', 445: 'SMB file sharing', 465: 'SMTPS',
    587: 'SMTP submission', 636: 'LDAPS', 1433: 'SQL Server', 1521: 'Oracle', 1883: 'MQTT',
    2049: 'NFS', 2375: 'Docker API', 3000: 'Web development', 3306: 'MySQL', 3389: 'Remote Desktop',
    5353: 'mDNS', 5355: 'LLMNR', 5357: 'WSDAPI', 5432: 'PostgreSQL', 5672: 'AMQP',
    5985: 'WinRM HTTP', 5986: 'WinRM HTTPS', 6379: 'Redis', 8080: 'Alternate HTTP',
    8443: 'Alternate HTTPS', 27017: 'MongoDB',
  }
  const purposes = language === 'zh' ? chinesePurposes : englishPurposes
  if (purposes[port]) return purposes[port]
  const process = processName?.toLowerCase()
  if (process === 'svchost.exe') return l(language, 'Windows system service', 'Windows 系统服务')
  if (process === 'system') return l(language, 'Windows kernel service', 'Windows 内核服务')
  return l(language, 'Application listener', '应用监听')
}

function ubuntuServiceType(port: number, processName: string | undefined, language: Language) {
  const process = processName?.toLowerCase().replace(/\.exe$/, '')
  const processTypes: Array<[string[], string, string]> = [
    [['sshd'], 'OpenSSH server', 'OpenSSH 服务'],
    [['nginx'], 'Nginx web server', 'Nginx Web 服务'],
    [['apache2', 'httpd'], 'Apache HTTP server', 'Apache HTTP 服务'],
    [['caddy'], 'Caddy web server', 'Caddy Web 服务'],
    [['traefik'], 'Traefik reverse proxy', 'Traefik 反向代理'],
    [['node', 'nodejs'], 'Node.js application', 'Node.js 应用'],
    [['bun'], 'Bun application', 'Bun 应用'],
    [['deno'], 'Deno application', 'Deno 应用'],
    [['uvicorn'], 'Uvicorn Python web service', 'Uvicorn Python Web 服务'],
    [['gunicorn'], 'Gunicorn Python web service', 'Gunicorn Python Web 服务'],
    [['daphne', 'hypercorn'], 'Python ASGI service', 'Python ASGI 服务'],
    [['python', 'python3'], 'Python application', 'Python 应用'],
    [['php-fpm', 'php-fpm8.1', 'php-fpm8.2', 'php-fpm8.3', 'php-fpm8.4'], 'PHP-FPM service', 'PHP-FPM 服务'],
    [['mysqld'], 'MySQL database', 'MySQL 数据库'],
    [['mariadbd'], 'MariaDB database', 'MariaDB 数据库'],
    [['postgres'], 'PostgreSQL database', 'PostgreSQL 数据库'],
    [['redis-server', 'redis-sentinel'], 'Redis service', 'Redis 服务'],
    [['mongod'], 'MongoDB database', 'MongoDB 数据库'],
    [['dockerd', 'docker-proxy'], 'Docker service', 'Docker 服务'],
    [['containerd'], 'containerd service', 'containerd 服务'],
    [['memcached'], 'Memcached service', 'Memcached 服务'],
    [['rabbitmq-server', 'beam.smp'], 'RabbitMQ service', 'RabbitMQ 服务'],
    [['mosquitto'], 'Mosquitto MQTT broker', 'Mosquitto MQTT 服务'],
    [['elasticsearch'], 'Elasticsearch service', 'Elasticsearch 服务'],
    [['grafana', 'grafana-server'], 'Grafana service', 'Grafana 服务'],
    [['prometheus'], 'Prometheus service', 'Prometheus 服务'],
    [['minio'], 'MinIO object storage', 'MinIO 对象存储'],
    [['influxd'], 'InfluxDB database', 'InfluxDB 数据库'],
    [['smbd', 'nmbd'], 'Samba file sharing', 'Samba 文件共享'],
    [['cupsd'], 'CUPS print service', 'CUPS 打印服务'],
    [['named'], 'BIND DNS server', 'BIND DNS 服务'],
    [['dnsmasq', 'systemd-resolve'], 'DNS service', 'DNS 服务'],
    [['vsftpd', 'proftpd'], 'FTP server', 'FTP 服务'],
    [['postfix', 'master', 'exim4'], 'Mail server', '邮件服务'],
  ]
  if (process) {
    const match = processTypes.find(([names]) => names.some((name) => process === name || process.startsWith(`${name}:`)))
    if (match) return l(language, match[1], match[2])
  }

  const portTypes: Record<number, [string, string]> = {
    21: ['FTP server', 'FTP 服务'], 22: ['OpenSSH server', 'OpenSSH 服务'],
    25: ['SMTP mail server', 'SMTP 邮件服务'], 53: ['DNS server', 'DNS 服务'],
    80: ['HTTP web service', 'HTTP Web 服务'], 110: ['POP3 mail server', 'POP3 邮件服务'],
    143: ['IMAP mail server', 'IMAP 邮件服务'], 443: ['HTTPS web service', 'HTTPS Web 服务'],
    445: ['Samba file sharing', 'Samba 文件共享'], 631: ['CUPS print service', 'CUPS 打印服务'],
    873: ['rsync service', 'rsync 服务'], 1883: ['MQTT broker', 'MQTT 服务'],
    2049: ['NFS file service', 'NFS 文件服务'], 2375: ['Docker API', 'Docker API'],
    2376: ['Docker TLS API', 'Docker TLS API'], 3000: ['Web application', 'Web 应用'],
    3306: ['MySQL / MariaDB', 'MySQL / MariaDB 数据库'], 5432: ['PostgreSQL database', 'PostgreSQL 数据库'],
    5672: ['RabbitMQ / AMQP', 'RabbitMQ / AMQP 服务'], 6379: ['Redis service', 'Redis 服务'],
    8000: ['Web application', 'Web 应用'], 8080: ['Web application', 'Web 应用'],
    8086: ['InfluxDB database', 'InfluxDB 数据库'], 8443: ['HTTPS application', 'HTTPS 应用'],
    9090: ['Prometheus service', 'Prometheus 服务'], 9092: ['Apache Kafka', 'Apache Kafka 服务'],
    9200: ['Elasticsearch HTTP', 'Elasticsearch HTTP 服务'], 9300: ['Elasticsearch transport', 'Elasticsearch 集群通信'],
    11211: ['Memcached service', 'Memcached 服务'], 27017: ['MongoDB database', 'MongoDB 数据库'],
  }
  const portType = portTypes[port]
  return portType ? l(language, portType[0], portType[1]) : l(language, 'Ubuntu service', 'Ubuntu 服务')
}

function ForwardingModal({ language, service, busy, onClose, onCreate }: {
  language: Language
  service: ServiceView
  busy: boolean
  onClose: () => void
  onCreate: (request: { proxyType: ProxyType; listenAddress: string; externalPort: number; targetAddress: string; targetPort: number; connectAddress?: string; enabled: boolean }) => Promise<boolean>
}) {
  const tcpBindings = service.bindings.filter((binding) => binding.protocol === 'tcp')
  const [targetIndex, setTargetIndex] = useState(0)
  const target = tcpBindings[targetIndex]
  const [externalPort, setExternalPort] = useState(target?.port ?? 0)
  const [proxyType, setProxyType] = useState<ProxyType>('v4tov4')
  const [listenAddress, setListenAddress] = useState('127.0.0.1')
  const [connectAddress, setConnectAddress] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [advanced, setAdvanced] = useState(false)

  const changeProxyType = (value: ProxyType) => {
    setProxyType(value)
    setListenAddress(value.startsWith('v6') ? '::1' : '127.0.0.1')
  }

  return <Modal title={l(language, `Configure forwarding for ${service.name}`, `配置 ${service.name} 的转发`)} subtitle={l(language, 'Select a TCP binding as the target. The default proxy type is v4tov4.', '选择服务的一个 TCP 绑定作为目标；默认代理类型为 v4tov4。')} onClose={onClose}>
    <div className="modal-body form-body">
      <div className="route-preview"><div><span>{l(language, 'Windows external', 'Windows 外部')}</span><strong>{listenAddress}:{externalPort || '—'}</strong></div><ArrowRight /><div><span>{service.category === 'wsl' ? `WSL · ${service.categoryDetail}` : l(language, 'Service binding', '服务绑定')}</span><strong>{connectAddress || target?.address}:{target?.port}</strong></div></div>
      <div className="form-grid">
        <label>{l(language, 'Target TCP binding', '目标 TCP 绑定')}<select value={targetIndex} onChange={(event) => { const index = Number(event.target.value); setTargetIndex(index); setExternalPort(tcpBindings[index].port) }}>{tcpBindings.map((binding, index) => <option key={`${binding.address}-${binding.port}`} value={index}>{binding.address}:{binding.port}</option>)}</select></label>
        <label>{l(language, 'External port', '外部端口')}<input type="number" min={1} max={65535} value={externalPort} onChange={(event) => setExternalPort(Number(event.target.value))} /></label>
        <label>{l(language, 'Initial state', '创建后状态')}<select value={enabled ? 'enabled' : 'disabled'} onChange={(event) => setEnabled(event.target.value === 'enabled')}><option value="enabled">{l(language, 'Enable immediately', '立即启用')}</option><option value="disabled">{l(language, 'Save configuration only', '仅保存配置')}</option></select></label>
      </div>
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={16} />{l(language, 'Advanced options', '高级选项')}<ChevronDown size={15} className={advanced ? 'open' : ''} /></button>
      {advanced && <div className="advanced-panel">
        <div className="form-grid">
          <label>{l(language, 'Proxy type', '代理类型')}<select value={proxyType} onChange={(event) => changeProxyType(event.target.value as ProxyType)}><option value="v4tov4">v4tov4 {l(language, '(default)', '（默认）')}</option><option value="v4tov6">v4tov6</option><option value="v6tov4">v6tov4</option><option value="v6tov6">v6tov6</option></select></label>
          <label>{l(language, 'Listen address', '监听地址')}<select value={listenAddress} onChange={(event) => setListenAddress(event.target.value)}>{proxyType.startsWith('v6') ? <><option value="::1">::1 {l(language, '(local only)', '（仅本机）')}</option><option value="::">:: {l(language, '(all interfaces)', '（所有网卡）')}</option></> : <><option value="127.0.0.1">127.0.0.1 {l(language, '(local only)', '（仅本机）')}</option><option value="0.0.0.0">0.0.0.0 {l(language, '(all interfaces)', '（所有网卡）')}</option></>}</select></label>
        </div>
        <label>{l(language, 'Target address override', '目标地址覆盖')} <span>{l(language, 'Optional', '可选')}</span><input value={connectAddress} onChange={(event) => setConnectAddress(event.target.value)} placeholder={proxyType.endsWith('v6') ? l(language, 'For example, ::1', '例如 ::1') : l(language, 'Leave blank for automatic resolution', '留空则自动解析')} /></label>
        {(listenAddress === '0.0.0.0' || listenAddress === '::') && <div className="security-note"><ShieldAlert size={15} />{l(language, 'Listening on all interfaces increases network exposure and may require a Windows Firewall rule.', '所有网卡监听会扩大局域网暴露面，且可能需要单独配置 Windows 防火墙。')}</div>}
      </div>}
      <div className="modal-actions"><button className="button ghost" onClick={onClose}>{l(language, 'Cancel', '取消')}</button><button className="button primary" disabled={busy || !target || externalPort < 1 || externalPort > 65535} onClick={() => target && void onCreate({ proxyType, listenAddress, externalPort, targetAddress: target.address, targetPort: target.port, connectAddress: connectAddress.trim() || undefined, enabled })}>{busy ? <RefreshCw size={16} className="spin" /> : <Network size={16} />}{l(language, 'Save forwarding', '保存转发')}</button></div>
    </div>
  </Modal>
}
