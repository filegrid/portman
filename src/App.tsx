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
import type { ApiError, Candidate, DashboardSnapshot, DiscoveryResult, ProxyType, ServiceView } from './types'

const emptySnapshot: DashboardSnapshot = {
  generatedAt: '',
  services: [],
  system: { ipHelperState: 'unknown' },
  warnings: [],
  configPath: '%USERPROFILE%\\.portman\\config.yaml',
}

function errorMessage(error: unknown) {
  if (typeof error === 'string') return error
  const apiError = error as ApiError
  return apiError?.message || String(error)
}

export default function App() {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'windows' | 'wsl' | 'issues'>('all')
  const [page, setPage] = useState<'services' | 'add'>('services')
  const [forwardingService, setForwardingService] = useState<ServiceView | null>(null)
  const [toast, setToast] = useState<{ kind: 'success' | 'error'; message: string } | null>(null)
  const refreshing = useRef(false)

  const refresh = useCallback(async (quiet = false) => {
    if (refreshing.current) return
    refreshing.current = true
    if (!quiet) setLoading(true)
    try {
      setSnapshot(await api.snapshot())
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error) })
    } finally {
      if (!quiet) setLoading(false)
      refreshing.current = false
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 4200)
    return () => window.clearTimeout(timer)
  }, [toast])

  const perform = async (operation: () => Promise<{ message: string }>) => {
    setBusy(true)
    try {
      const result = await operation()
      setToast({ kind: 'success', message: result.message })
      await refresh(true)
      return true
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error) })
      return false
    } finally {
      setBusy(false)
    }
  }

  const openDirectory = async (operation: () => Promise<{ message: string }>) => {
    try {
      const result = await operation()
      setToast({ kind: 'success', message: result.message })
    } catch (error) {
      setToast({ kind: 'error', message: errorMessage(error) })
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

  const running = snapshot.services.filter((service) => service.runtimeState === 'running').length
  const forwarded = snapshot.services.filter((service) => service.forwardingState === 'active').length
  const externallyAccessible = snapshot.services.filter((service) => service.networkExposed).length
  const issues = snapshot.services.filter((service) =>
    ['conflict', 'unknown'].includes(service.runtimeState)
    || ['conflict', 'error', 'repair_required'].includes(service.forwardingState),
  ).length

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
        {page === 'add' ? <AddServicePage busy={busy} onBack={() => setPage('services')} onOpenCandidate={(token) => void openDirectory(() => api.openCandidateProcessDirectory(token))} onCreate={async (candidates, name) => {
          const ok = await perform(() => api.createService(candidates.map((candidate) => candidate.candidateToken), name))
          if (ok) setPage('services')
          return ok
        }} /> : <>
        <header className="topbar">
          <div>
            <p className="eyebrow">LOCAL SERVICES</p>
            <h1>服务端口</h1>
            <p className="subtitle">关注本机与 WSL 服务，统一管理内部端口和 Windows 转发。</p>
          </div>
          <div className="header-actions">
            <button className="button ghost" onClick={() => void refresh()} disabled={loading || busy}>
              <RefreshCw size={16} className={loading ? 'spin' : ''} />刷新
            </button>
            <button className="button primary" onClick={() => setPage('add')}><Plus size={17} />添加服务</button>
          </div>
        </header>

        {snapshot.system.ipHelperState === 'stopped' && (
          <div className="banner warning">
            <ShieldAlert size={18} />
            <div><strong>IP Helper 未运行</strong><span>已配置的 Windows PortProxy 无法生效。</span></div>
            <button onClick={() => void perform(api.startIpHelper)} disabled={busy}>启动服务</button>
          </div>
        )}

        {snapshot.warnings.length > 0 && (
          <div className="banner subtle"><AlertTriangle size={17} /><span>{snapshot.warnings[0].message}</span></div>
        )}

        <section className="stats-grid">
          <StatCard icon={<Box size={19} />} label="关注服务" value={snapshot.services.length} tone="blue" />
          <StatCard icon={<Activity size={19} />} label="正在运行" value={running} tone="green" />
          <StatCard icon={<ArrowRight size={19} />} label="转发已生效" value={forwarded} tone="violet" />
          <StatCard icon={<ShieldAlert size={19} />} label="对外访问" value={externallyAccessible} tone="amber" />
          <StatCard icon={<AlertTriangle size={19} />} label="需要处理" value={issues} tone="red" />
        </section>

        <section className="service-panel">
          <div className="panel-toolbar">
            <div className="search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索服务、端口、进程或路径…" /></div>
            <div className="filters">
              {(['all', 'windows', 'wsl', 'issues'] as const).map((value) => (
                <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>
                  {{ all: '全部', windows: 'Windows', wsl: 'WSL', issues: '异常' }[value]}
                </button>
              ))}
            </div>
          </div>

          <div className="service-table">
            <div className="table-head table-row">
              <span>服务</span><span>状态</span><span>服务端点</span><span>外部端点</span><span>转发</span><span>操作</span>
            </div>
            {loading && snapshot.services.length === 0 ? (
              <div className="empty"><RefreshCw className="spin" /><strong>正在扫描端口</strong><span>读取 Windows 与 WSL 监听服务…</span></div>
            ) : filteredServices.length === 0 ? (
              <div className="empty"><Network /><strong>{snapshot.services.length ? '没有匹配的服务' : '还没有关注服务'}</strong><span>{snapshot.services.length ? '调整搜索或筛选条件。' : '从当前正在监听的服务来源中添加第一个服务。'}</span>{!snapshot.services.length && <button className="button primary" onClick={() => setPage('add')}><Plus size={16} />添加服务</button>}</div>
            ) : filteredServices.map((service) => (
              <ServiceRow
                key={service.id}
                service={service}
                busy={busy}
                onCreateForwarding={() => setForwardingService(service)}
                onOpenProcessDirectory={() => void openDirectory(() => api.openServiceProcessDirectory(service.id))}
                onToggle={(enabled) => void perform(() => api.setForwardingEnabled(service.id, enabled))}
                onDeleteForwarding={() => {
                  if (window.confirm(`删除 ${service.name} 的端口转发配置？`)) void perform(() => api.deleteForwarding(service.id))
                }}
                onRemove={() => {
                  if (window.confirm(`取消关注 ${service.name}？启用中的托管转发也会被清理。`)) void perform(() => api.removeService(service.id))
                }}
              />
            ))}
          </div>
          <footer className="panel-footer"><span>配置文件</span><code>{snapshot.configPath}</code><span className="spacer" /><span>仅手动刷新，操作后自动更新</span></footer>
        </section>
        </>}
      </main>

      {forwardingService && <ForwardingModal service={forwardingService} busy={busy} onClose={() => setForwardingService(null)} onCreate={async (request) => {
        const ok = await perform(() => api.createForwarding({ serviceId: forwardingService.id, ...request }))
        if (ok) setForwardingService(null)
        return ok
      }} />}

      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <Check size={17} /> : <AlertTriangle size={17} />}<span>{toast.message}</span><button onClick={() => setToast(null)}><X size={15} /></button></div>}
    </div>
  )
}

function StatCard({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: string }) {
  return <div className="stat-card"><div className={`stat-icon ${tone}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong></div></div>
}

function ServiceRow({ service, busy, onCreateForwarding, onOpenProcessDirectory, onToggle, onDeleteForwarding, onRemove }: {
  service: ServiceView
  busy: boolean
  onCreateForwarding: () => void
  onOpenProcessDirectory: () => void
  onToggle: (enabled: boolean) => void
  onDeleteForwarding: () => void
  onRemove: () => void
}) {
  const [menu, setMenu] = useState(false)
  return <div className="table-row service-row" onContextMenu={(event) => { event.preventDefault(); setMenu(true) }}>
    <div className="service-cell">
      <div className={`service-icon ${service.category}`}><Server size={17} /></div>
      <div className="truncate"><strong>{service.name}</strong><span title={service.process?.path}>{service.category === 'wsl' ? service.categoryDetail : service.process?.name || 'Windows 服务'}{service.process?.pid ? ` · PID ${service.process.pid}` : ''}</span></div>
    </div>
    <div className="service-status-cell"><StatusBadge kind="runtime" state={service.runtimeState} />{service.networkExposed && <span className="exposure-badge" title="绑定到非回环地址，可能被局域网或公网直接访问，实际范围取决于防火墙和路由"><ShieldAlert size={11} />对外监听</span>}</div>
    <BindingsCell bindings={service.bindings} />
    <ActualMappingsCell mappings={service.actualForwardings} />
    <div className="forward-cell"><StatusBadge kind="forwarding" state={service.forwardingState} />{service.actualForwardings.length > 0 && <small>{[...new Set(service.actualForwardings.map((mapping) => mapping.proxyType))].join(' · ')}</small>}</div>
    <div className="row-actions">
      {service.capabilities.canCreateForwarding && <button className="compact primary" onClick={onCreateForwarding}>配置转发</button>}
      {service.capabilities.canEnableForwarding && <button className="compact" disabled={busy} onClick={() => onToggle(true)}>启用</button>}
      {service.capabilities.canDisableForwarding && <button className="compact" disabled={busy} onClick={() => onToggle(false)}>禁用</button>}
      <div className="menu-wrap">
        <button className="icon-button" onClick={() => setMenu(!menu)}><ChevronDown size={16} /></button>
        {menu && <div className="context-menu">
          {service.process?.path && <button onClick={() => { setMenu(false); onOpenProcessDirectory() }}><FolderOpen size={15} />打开进程目录</button>}
          {service.capabilities.canDeleteForwarding && <button onClick={() => { setMenu(false); onDeleteForwarding() }}><CircleOff size={15} />删除转发</button>}
          <button className="danger" onClick={() => { setMenu(false); onRemove() }}><Trash2 size={15} />取消关注</button>
        </div>}
      </div>
    </div>
    {service.diagnostics.length > 0 && <div className="row-diagnostic" title={service.diagnostics.map((item) => item.message).join('\n')}><AlertTriangle size={13} />{service.diagnostics[0].message}</div>}
  </div>
}

function ActualMappingsCell({ mappings }: { mappings: ServiceView['actualForwardings'] }) {
  if (!mappings.length) return <div className="endpoint empty-value">无实际映射</div>
  return <div className="binding-stack actual-mappings" title={mappings.map((mapping) => `${mapping.listenAddress}:${mapping.externalPort} → ${mapping.connectAddress}:${mapping.targetPort}`).join('\n')}>
    {mappings.slice(0, 2).map((mapping) => <div className="binding-line" key={`${mapping.proxyType}-${mapping.listenAddress}-${mapping.externalPort}`}><code>{mapping.listenAddress.includes(':') ? `[${mapping.listenAddress}]` : mapping.listenAddress}<b>:{mapping.externalPort}</b></code></div>)}
    {mappings.length > 2 && <small>另有 {mappings.length - 2} 条实际映射</small>}
  </div>
}

function BindingsCell({ bindings }: { bindings: ServiceView['bindings'] }) {
  const shown = bindings.slice(0, 3)
  return <div className="binding-stack">
    {shown.map((binding) => <div className={`binding-line ${binding.active ? '' : 'inactive'}`} key={`${binding.protocol}-${binding.address}-${binding.port}`}>
      <span className={`protocol ${binding.protocol}`}>{binding.protocol.toUpperCase()}</span>
      <code>{binding.address.includes(':') ? `[${binding.address}]` : binding.address}<b>:{binding.port}</b></code>
    </div>)}
    {bindings.length > shown.length && <small>另有 {bindings.length - shown.length} 个绑定</small>}
  </div>
}

function StatusBadge({ kind, state }: { kind: 'runtime' | 'forwarding'; state: string }) {
  const labels: Record<string, string> = {
    running: '运行中', stopped: '已停止', conflict: '冲突', unknown: '未知',
    unconfigured: '未配置', not_required: '无需转发', disabled: '已禁用', active: '已生效', repair_required: '需修复', error: '错误',
  }
  return <span className={`status-badge ${state}`}><i />{labels[state] || state}{kind === 'runtime' && state === 'stopped' ? '' : ''}</span>
}

function Modal({ title, subtitle, onClose, children }: { title: string; subtitle: string; onClose: () => void; children: React.ReactNode }) {
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal"><div className="modal-head"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div>{children}</div>
  </div>
}

function AddServicePage({ busy, onBack, onOpenCandidate, onCreate }: { busy: boolean; onBack: () => void; onOpenCandidate: (token: string) => void; onCreate: (candidates: Candidate[], name: string) => Promise<boolean> }) {
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
    try { setResult(await api.discover()) } catch (value) { setError(errorMessage(value)) }
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
      <div className="add-title"><button className="page-back" onClick={onBack}><ArrowLeft size={17} />返回</button><h1>添加服务</h1></div>
      <div className="candidate-toolbar add-header-tools">
        <div className="search modal-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索端口、进程或 WSL 发行版…" /><button onClick={() => void load()}><RefreshCw size={15} /></button></div>
        <div className="filters protocol-filters">
          <button className={showTcp ? 'active' : ''} onClick={() => setShowTcp(!showTcp)}>TCP</button>
          <button className={showUdp ? 'active' : ''} onClick={() => setShowUdp(!showUdp)}>UDP</button>
          <button className={showWindowsSystemServices ? 'active' : ''} onClick={() => setShowWindowsSystemServices(!showWindowsSystemServices)}>系统服务</button>
        </div>
      </div>
    </header>
    <section className="service-panel add-panel"><div className="add-panel-body">
      {error ? <div className="inline-error"><AlertTriangle size={16} />{error}<button onClick={() => void load()}>重试</button></div> : !result ? <div className="modal-loading"><RefreshCw className="spin" />正在发现监听服务…</div> : (
        <div className="source-list">
          {sourceGroups.length === 0 && <div className="modal-loading">没有可添加的监听服务</div>}
          {sourceGroups.map((group) => {
            const visibleBindings = group.candidates.filter((item) => candidateVisible(item, showTcp, showUdp, showWindowsSystemServices))
            const candidate = visibleBindings[0] ?? group.candidates[0]
            const relations = [...new Map(group.candidates.flatMap((item) => item.portProxyRelations).map((relation) => [`${relation.role}-${relation.otherPort}`, relation])).values()]
            const isPortProxyListener = relations.some((relation) => relation.role === 'source')
            const exposed = visibleBindings.some((binding) => binding.category === 'windows' && isNetworkExposed(binding.address))
            const purpose = candidate.category === 'windows' ? windowsPortPurpose(candidate.port, candidate.processName) : 'WSL 服务'
            return <button key={group.key} className={selectedKey === group.key ? 'source-card selected' : 'source-card'} onContextMenu={(event) => { event.preventDefault(); setContextCandidate({ candidate, x: Math.min(event.clientX, window.innerWidth - 170), y: Math.min(event.clientY, window.innerHeight - 52) }) }} onClick={() => { setSelectedKey(group.key); setName(isPortProxyListener ? `PortProxy ${candidate.port}` : candidate.processName || `端口 ${candidate.port}`) }}>
              <div className={`service-icon ${candidate.category}`}><Server size={17} /></div>
              <strong className="port-number">{candidate.port}</strong>
              <div className="candidate-main"><strong>{isPortProxyListener ? 'IP Helper' : candidate.processName || '未知进程'}</strong><span>{isPortProxyListener ? `Windows 服务 · ${candidate.processName || 'svchost.exe'}` : candidate.category === 'wsl' ? `WSL · ${candidate.categoryDetail}` : 'Windows'}{candidate.pid ? ` · PID ${candidate.pid}` : ''}</span></div>
              <div className={`mapping-cell ${relations.length ? 'mapped' : ''}`}><span>{relations.length ? relations.map((relation) => relation.role === 'source' ? `映射入口 · 目标 ${relation.otherPort}` : `映射目标 · 入口 ${relation.otherPort}`).join('；') : purpose}</span>{exposed && <strong className="exposure-badge" title="绑定到非回环地址，可能被局域网或公网直接访问，实际范围取决于防火墙和路由"><ShieldAlert size={11} />对外监听</strong>}</div>
              <div className="source-bindings">{visibleBindings.map((binding) => <span className="binding-chip" key={binding.candidateToken}><i className={binding.protocol}>{binding.protocol.toUpperCase()}</i>{binding.address.includes(':') ? `[${binding.address}]` : binding.address}</span>)}</div>
            </button>
          })}
        </div>
      )}
      {selected && <div className="selection-bar"><label>服务名称<input autoFocus value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label><button className="button ghost" onClick={onBack}>取消</button><button className="button primary" disabled={busy || !name.trim()} onClick={() => void onCreate(selected.candidates, name)}>加入关注</button></div>}
    </div></section>
    {contextCandidate && <div className="context-menu candidate-context-menu" style={{ left: contextCandidate.x, top: contextCandidate.y }} onClick={(event) => event.stopPropagation()}>
      <button disabled={!contextCandidate.candidate.processPath} onClick={() => { onOpenCandidate(contextCandidate.candidate.candidateToken); setContextCandidate(null) }}><FolderOpen size={15} />打开进程目录</button>
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

function windowsPortPurpose(port: number, processName?: string) {
  const purposes: Record<number, string> = {
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
  if (purposes[port]) return purposes[port]
  const process = processName?.toLowerCase()
  if (process === 'svchost.exe') return 'Windows 系统服务'
  if (process === 'system') return 'Windows 内核服务'
  return '应用监听'
}

function ForwardingModal({ service, busy, onClose, onCreate }: {
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

  return <Modal title={`配置 ${service.name} 的转发`} subtitle="选择服务的一个 TCP 绑定作为目标；默认代理类型为 v4tov4。" onClose={onClose}>
    <div className="modal-body form-body">
      <div className="route-preview"><div><span>Windows 外部</span><strong>{listenAddress}:{externalPort || '—'}</strong></div><ArrowRight /><div><span>{service.category === 'wsl' ? `WSL · ${service.categoryDetail}` : '服务绑定'}</span><strong>{connectAddress || target?.address}:{target?.port}</strong></div></div>
      <div className="form-grid">
        <label>目标 TCP 绑定<select value={targetIndex} onChange={(event) => { const index = Number(event.target.value); setTargetIndex(index); setExternalPort(tcpBindings[index].port) }}>{tcpBindings.map((binding, index) => <option key={`${binding.address}-${binding.port}`} value={index}>{binding.address}:{binding.port}</option>)}</select></label>
        <label>外部端口<input type="number" min={1} max={65535} value={externalPort} onChange={(event) => setExternalPort(Number(event.target.value))} /></label>
        <label>创建后状态<select value={enabled ? 'enabled' : 'disabled'} onChange={(event) => setEnabled(event.target.value === 'enabled')}><option value="enabled">立即启用</option><option value="disabled">仅保存配置</option></select></label>
      </div>
      <button className="advanced-toggle" onClick={() => setAdvanced(!advanced)}><SlidersHorizontal size={16} />高级选项<ChevronDown size={15} className={advanced ? 'open' : ''} /></button>
      {advanced && <div className="advanced-panel">
        <div className="form-grid">
          <label>代理类型<select value={proxyType} onChange={(event) => changeProxyType(event.target.value as ProxyType)}><option value="v4tov4">v4tov4（默认）</option><option value="v4tov6">v4tov6</option><option value="v6tov4">v6tov4</option><option value="v6tov6">v6tov6</option></select></label>
          <label>监听地址<select value={listenAddress} onChange={(event) => setListenAddress(event.target.value)}>{proxyType.startsWith('v6') ? <><option value="::1">::1（仅本机）</option><option value="::">::（所有网卡）</option></> : <><option value="127.0.0.1">127.0.0.1（仅本机）</option><option value="0.0.0.0">0.0.0.0（所有网卡）</option></>}</select></label>
        </div>
        <label>目标地址覆盖 <span>可选</span><input value={connectAddress} onChange={(event) => setConnectAddress(event.target.value)} placeholder={proxyType.endsWith('v6') ? '例如 ::1' : '留空则自动解析'} /></label>
        {(listenAddress === '0.0.0.0' || listenAddress === '::') && <div className="security-note"><ShieldAlert size={15} />所有网卡监听会扩大局域网暴露面，且可能需要单独配置 Windows 防火墙。</div>}
      </div>}
      <div className="modal-actions"><button className="button ghost" onClick={onClose}>取消</button><button className="button primary" disabled={busy || !target || externalPort < 1 || externalPort > 65535} onClick={() => target && void onCreate({ proxyType, listenAddress, externalPort, targetAddress: target.address, targetPort: target.port, connectAddress: connectAddress.trim() || undefined, enabled })}>{busy ? <RefreshCw size={16} className="spin" /> : <Network size={16} />}保存转发</button></div>
    </div>
  </Modal>
}
