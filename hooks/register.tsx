import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit, Timer, TurnStepResult } from 'claude-code'

import type { Agent, Breakdown, Cache, Day, Git, GitFile, Limit, Model, Scoped, Snapshot, Weather } from '../types'

const snapshot = atom({ plugin: 'session-panel', key: 'snapshot' } as const, null)
const breakdown = atom({ plugin: 'session-panel', key: 'breakdown' } as const, null)
const rate = atom({ plugin: 'session-panel', key: 'rate' } as const, [])
const scoped = atom({ plugin: 'session-panel', key: 'scoped' } as const, null)
const cache = atom({ plugin: 'session-panel', key: 'cache' } as const, null)
const model = atom({ plugin: 'session-panel', key: 'model' } as const, null)
const git = atom({ plugin: 'session-panel', key: 'git' } as const, null)
const weather = atom({ plugin: 'session-panel', key: 'weather' } as const, null)
const agents = atom({ plugin: 'session-panel', key: 'agents' } as const, [])
const tick = atom({ plugin: 'session-panel', key: 'tick' } as const, 0)

// Claude Code's own folder: where the login and the session transcripts live.
const configDir = async ($: EngineInterface) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (dir) return dir
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return home ? `${home}/.claude` : null
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const MINUTE = 60 * 1000
const STALE_MS = 5 * MINUTE
const MAX_AGE_MS = 6 * 60 * MINUTE
const WEATHER_TTL_MS = 30 * MINUTE
const PLACE_TTL_MS = 24 * 60 * MINUTE

const FREE = '#3a4152'
const MARKER = '#e8a33d'
const HEADING = '#9aa4b2'

// Everything is drawn in one pane, docked beside the transcript in the fullscreen layout.
const PANE = 'session-panel'
const PANE_TITLE = 'Session'
// The dock's width when it opens; a width the person drags it to wins.
const PANE_COLUMNS = 44

export const fmt = (n: number) =>
  n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M`
  : n >= 1e4 ? `${Math.round(n / 1000)}k`
  : n >= 1e3 ? `${+(n / 1000).toFixed(1)}k`
  : `${n}`

// Every write redraws the band, so each value is written only when it changed.
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// One fetch at a time, and after a failure (offline, an expired login) none for STALE_MS.
type Fetching = { now: boolean; lastTry: number }
const mayFetch = (f: Fetching, now: number) => !f.now && now - f.lastTry >= STALE_MS

// ---- Model and effort ------------------------------------------------------

// The effort level runs cool to hot.
const MODEL_COLOR = '#bd93f9'
const EFFORT_COLOR: Record<string, string> = {
  low: '#61afef', medium: '#50fa7b', high: '#f1fa8c', xhigh: '#ff9650', max: '#ff5555',
}

// "claude-opus-5-5[1m]" reads "Opus 5.5"; anything else is shown as it came.
export const modelName = (id: string) => {
  const bare = id.replace(/\[.*\]$/, '')
  const m = bare.match(/^claude-([a-z]+)-(\d+)-(\d+)/i)
  if (!m) return bare
  const [, family = '', major, minor] = m
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
}

const modelText = (m: Model) => `${m.name}${m.effort ? ` [${m.effort}]` : ''}`

// Until the first request names them: the session's model and the effort in settings.
const loadModel = async ($: EngineInterface) => {
  try {
    if (await read($, model)) return
    const [id, settings] = await Promise.all([$.session.model(), $.settings.read()])
    // A per-model effort (modelSettings) wins over the general one, as the engine reads them.
    const s = settings as { effortLevel?: unknown; modelSettings?: Record<string, { effortLevel?: unknown }> }
    const effort = s.modelSettings?.[id.replace(/\[.*\]$/, '')]?.effortLevel ?? s.effortLevel
    const m: Model = { name: modelName(id), effort: typeof effort === 'string' ? effort : undefined }
    await update($, model, current => current ?? m)
  } catch {
    // The first turn's request names the model anyway.
  }
}

// ---- Repository ------------------------------------------------------------

const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p

// A changed entry's path follows a fixed number of fields: 8 for an ordinary change, 9 for
// a rename or copy (its old path after a tab), 10 for a merge conflict.
const PATH_AFTER: Record<string, number> = { '1': 8, '2': 9, u: 10 }

// `git status --porcelain=v2 --branch` in one process: the branch, the commit, and a line per change.
export const parseStatus = (name: string, out: string): Git => {
  let head = ''
  let oid = ''
  const files: GitFile[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('# branch.head ')) head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) oid = line.slice(13).trim()
    else if (line.startsWith('? ')) files.push({ code: '??', path: line.slice(2).trim() })
    else if (line.trim() && !line.startsWith('#') && !line.startsWith('!')) {
      const parts = line.split(' ')
      const skip = PATH_AFTER[parts[0] ?? ''] ?? 8
      // A conflict is a conflict whatever its two sides did (AA, DD, UD...): one red U.
      const code = parts[0] === 'u' ? 'UU' : parts[1] ?? '..'
      files.push({ code, path: (parts.slice(skip).join(' ').split('\t')[0] ?? '').trim() })
    }
  }
  const isDetached = head === '(detached)'
  return { name, branch: isDetached ? oid.slice(0, 7) : head || undefined, isDetached, changes: files.length, files }
}

// The one letter that says most about a file: the working tree's change, else the staged one.
export const fileLetter = (code: string) => {
  if (code === '??') return '?'
  const [x = '.', y = '.'] = code
  return y !== '.' ? y : x
}

const FILE_COLOR: Record<string, string> = {
  M: '#e6c46a', A: '#86c58a', D: '#e07a5f', R: '#8be9fd', C: '#8be9fd', U: '#ff5555', '?': '#7f8796',
}

// A path cut from the left, so the file's own name always shows.
export const tailPath = (path: string, width: number) =>
  path.length <= width ? path : `…${path.slice(path.length - width + 1)}`

const MAX_FILES = 8

let repoName: { name: string; isRepo: boolean } | null = null

const loadGit = async ($: EngineInterface) => {
  try {
    if (!repoName) {
      const repo = await $.session.repo()
      repoName = repo ? { name: baseName(repo.root), isRepo: true } : { name: baseName(await $.session.cwd()), isRepo: false }
    }
    if (!repoName.isRepo) {
      {
        const v = { name: repoName.name, changes: 0, files: [] }
        if (!same(await read($, git), v)) await update($, git, () => v)
      }
      return
    }
    // Unquoted paths, so a name like café.txt reads as itself rather than as escape codes.
    const r = await $.process.run(['git', '-c', 'core.quotePath=false', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5000 })
    if (r.exitCode === 0) {
      const v = parseStatus(repoName.name, r.stdout)
      if (!same(await read($, git), v)) await update($, git, () => v)
    }
  } catch {
    // git missing or slow: keep what was there.
  }
}

// ---- Weather ---------------------------------------------------------------

type Place = { lat: number; lon: number; name: string; at: number }

// WMO weather codes, as Open-Meteo reports them.
export const icon = (code: number, isDay = true) =>
  code === 0 ? (isDay ? '☀️' : '🌙')
  : code === 1 ? (isDay ? '🌤️' : '🌙')
  : code === 2 ? '⛅'
  : code === 3 ? '☁️'
  : code <= 48 ? '🌫️'
  : code <= 57 ? '🌦️'
  : code <= 67 ? '🌧️'
  : code <= 77 ? '🌨️'
  : code <= 82 ? '🌧️'
  : code <= 86 ? '🌨️'
  : '⛈️'

// Cold blue through mild green to hot red, °C.
const STOPS: [number, [number, number, number]][] = [
  [-20, [122, 162, 247]],
  [-5, [137, 221, 255]],
  [5, [158, 206, 106]],
  [15, [230, 196, 106]],
  [25, [255, 158, 100]],
  [35, [247, 118, 142]],
]
export const tempColor = (t: number) => {
  const first = STOPS[0]!
  const last = STOPS[STOPS.length - 1]!
  const x = Math.max(first[0], Math.min(last[0], t))
  const i = Math.max(0, STOPS.findIndex(([at]) => at >= x) - 1)
  const [a, ca] = STOPS[i]!
  const [b, cb] = STOPS[Math.min(STOPS.length - 1, i + 1)]!
  const f = b === a ? 0 : (x - a) / (b - a)
  const hex = (k: number) => Math.round(ca[k]! + (cb[k]! - ca[k]!) * f).toString(16).padStart(2, '0')
  return `#${hex(0)}${hex(1)}${hex(2)}`
}

export const deg = (t: number) => `${Math.round(t)}°`

// One day's low-to-high span on the week's scale, each cell coloured by its own temperature.
export const span = (d: Day, min: number, max: number, n: number) => {
  const step = (max - min) / n || 1
  const cells = Array.from({ length: n }, (_, i) => {
    const t = min + (i + 0.5) * step
    return { t, isIn: t >= d.lo && t <= d.hi }
  })
  if (!cells.some(c => c.isIn)) {
    const mid = Math.min(n - 1, Math.max(0, Math.floor(((d.lo + d.hi) / 2 - min) / step)))
    cells[mid]!.isIn = true
  }
  return cells.map(c => ({ char: c.isIn ? '━' : '─', color: c.isIn ? tempColor(c.t) : FREE }))
}

const weekday = (date: string) => {
  const [y = 0, m = 1, d = 1] = date.split('-').map(Number)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? ''
}

const RAINY = 30

// Always five cells (" 100%"), so the temperature columns line up whether or not a day is rainy.
export const rainText = (d: Day) => (d.rain >= RAINY ? ` ${d.rain}%`.padStart(5) : '     ')

// A day's row is weekday, icon, rain, low, strip, high: 22 cells and the strip, each
// temperature given four ("-15°").
export const stripWidth = (columns: number) => Math.min(24, Math.max(4, columns - 22))

const weatherFetch: Fetching = { now: false, lastTry: 0 }

const loadWeather = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    let current = await read($, weather)
    if (!current) {
      // A new session draws the last forecast at once, then refreshes it if old.
      current = ((await $.store.get('weather')) as Weather | undefined) ?? null
      if (current) {
        const v = current
        if (!same(await read($, weather), v)) await update($, weather, () => v)
      }
    }
    const isFresh = current !== null && now - current.fetchedAt < WEATHER_TTL_MS
    if (isFresh || !mayFetch(weatherFetch, now)) return
    weatherFetch.now = true
    weatherFetch.lastTry = now
    try {
      const w = await fetchWeather($, now)
      if (w) {
        await $.store.set('weather', w)
        {
          const v = w
          if (!same(await read($, weather), v)) await update($, weather, () => v)
        }
      }
    } finally {
      weatherFetch.now = false
    }
  } catch {
    // Offline or no store: the last forecast stays up.
  }
}

const fetchWeather = async ($: EngineInterface, now: number): Promise<Weather | null> => {
  let place = (await $.store.get('place')) as Place | undefined
  if (!place || now - place.at > PLACE_TTL_MS) {
    try {
      // wttr.in places the machine by its IP address.
      const r = await $.http.fetch('https://wttr.in/?format=j1', { headers: { 'User-Agent': 'curl/8 (session-panel)' } })
      const area = (JSON.parse(r.text) as { nearest_area: { latitude: string; longitude: string; areaName: { value: string }[] }[] }).nearest_area[0]
      if (area) {
        place = { lat: Number(area.latitude), lon: Number(area.longitude), name: area.areaName[0]?.value ?? '', at: now }
        await $.store.set('place', place)
      }
    } catch {
      // Keep the place we had, if any.
    }
  }
  if (!place) return null

  const r = await $.http.fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.lat}&longitude=${place.lon}` +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&current=temperature_2m,weather_code,is_day&timezone=auto&forecast_days=5',
  )
  if (!r.ok) return null
  const j = JSON.parse(r.text) as {
    current: { temperature_2m: number; weather_code: number; is_day: number }
    daily: {
      time: string[]
      weather_code: number[]
      temperature_2m_max: number[]
      temperature_2m_min: number[]
      precipitation_probability_max: (number | null)[]
    }
  }
  return {
    fetchedAt: now,
    place: place.name,
    temp: j.current.temperature_2m,
    code: j.current.weather_code,
    isDay: j.current.is_day === 1,
    days: j.daily.time.map((date, i) => ({
      date,
      code: j.daily.weather_code[i] ?? 3,
      hi: j.daily.temperature_2m_max[i] ?? 0,
      lo: j.daily.temperature_2m_min[i] ?? 0,
      rain: j.daily.precipitation_probability_max[i] ?? 0,
    })),
  }
}

// ---- Usage allowances and the prompt cache ---------------------------------

// Each allowance's label has its own colour.
const LIMIT_LABEL: Record<string, string> = { '5h': '#ff79c6', week: '#bd93f9', cache: '#8be9fd' }
const MODEL_LABEL = '#ffb86c'

const meterColor = (l: Limit) =>
  l.color ? l.color
  : l.percent < 50 ? '#86c58a'
  : l.percent < 80 ? '#e6c46a'
  : l.percent < 90 || !l.isModel ? MARKER
  : '#e07a5f'

export const fmtReset = (ms: number) => {
  if (ms <= 0) return 'now'
  const min = Math.floor(ms / 60000)
  const d = Math.floor(min / 1440)
  const h = Math.floor((min % 1440) / 60)
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${min % 60}m` : `${min % 60}m`
}

export const toLimits = (windows: readonly SessionRateLimit[]): Limit[] =>
  windows.map(w => ({
    label: w.kind === 'five_hour' ? '5h' : w.kind === 'seven_day' ? 'week' : w.kind.replace(/_/g, ' '),
    percent: w.percentUsed,
    resetsAt: w.resetsAt ? Date.parse(w.resetsAt) : undefined,
  }))

// One allowance per row, labels and figures padded so every bar starts and ends in line.
export const meters = (limits: Limit[], columns: number, now: number) => {
  const resets = limits.map(l => l.note ?? (l.resetsAt === undefined ? '' : fmtReset(l.resetsAt - now)))
  const labelWidth = Math.max(0, ...limits.map(l => l.label.length))
  const resetWidth = Math.max(0, ...resets.map(r => r.length))
  const width = Math.max(4, columns - labelWidth - 1 - 1 - 4 - (resetWidth > 0 ? 1 + resetWidth : 0))

  return limits.map((l, i) => {
    const p = Math.max(0, Math.min(100, l.percent))
    const filled = Math.round((p / 100) * width)
    return {
      limit: l,
      label: l.label.padEnd(labelWidth),
      pct: `${Math.round(l.percent)}%`.padStart(4),
      reset: resets[i] ?? '',
      color: meterColor(l),
      filled,
      empty: width - filled,
    }
  })
}

const svgMeter = (percent: number, color: string) => {
  const W = 200
  const w = (Math.max(0, Math.min(100, percent)) / 100) * W
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 16" preserveAspectRatio="none"><rect width="${W}" height="16" rx="3" fill="${FREE}"/><rect width="${w}" height="16" rx="3" fill="${color}"/></svg>`
}

// The prompt cache as a bar that drains: full just after a response, empty once it expires.
export const cacheLimit = (c: Cache, now: number): Limit => {
  // `now` is the last minute's tick, so a response since then reads as a full cache.
  const left = Math.min(c.ttlMs, c.lastAt + c.ttlMs - now)
  if (left <= 0) return { label: 'cache', percent: 0, note: 'expired', color: CACHE_RED, isWarning: true }
  const percent = (left / c.ttlMs) * 100
  return {
    label: 'cache',
    percent,
    note: `${left < 60000 ? '<1m' : fmtReset(left)} left`,
    color: cacheColor(percent),
    isWarning: percent <= 25,
  }
}

// By the share of its life left, not by minutes, so a 1-hour cache and a 5-minute one
// warn alike: once it lapses, the next request sends the whole context again at full price.
const CACHE_RED = '#e07a5f'
export const cacheColor = (percentLeft: number) =>
  percentLeft > 50 ? '#86c58a' : percentLeft > 25 ? '#e6c46a' : percentLeft > 10 ? MARKER : CACHE_RED

// The cache's lifetime (5 minutes or an hour) is the account's; once known it is kept.
let ttlMs: number | null = null
let isTtlChecked = false

// Reads the last cached response from the transcript: on resuming a session, and once a
// session to confirm the lifetime. Every other turn's end is marked without it.
const readTranscriptCache = async ($: EngineInterface) => {
  isTtlChecked = true
  try {
    const [id, dir] = await Promise.all([$.session.id(), configDir($)])
    if (!dir) return
    // Shipped with the mod; without Node the cache bar stays hidden.
    const script = `${$.plugin.root}/scripts/cache-expiry.js`
    const { stdout } = await $.process.run(['node', script, id, dir], { timeoutMs: 15000 })
    const c = JSON.parse(stdout) as Cache | null
    if (c) {
      ttlMs = c.ttlMs
      await $.store.set('cacheTtl', c.ttlMs)
      {
        const v = c
        if (!same(await read($, cache), v)) await update($, cache, () => v)
      }
    }
  } catch {
    // No transcript yet, or node missing: keep what was there.
  }
}

const markCached = async ($: EngineInterface) => {
  if (ttlMs !== null) {
    const v = { lastAt: await $.clock.now(), ttlMs }
    if (!same(await read($, cache), v)) await update($, cache, () => v)
  }
  if (!isTtlChecked) await readTranscriptCache($)
}

const scopedFetch: Fetching = { now: false, lastTry: 0 }

// Per-model weekly limits (Fable) from the account's usage endpoint, with the login on disk.
const loadScoped = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    let current = await read($, scoped)
    if (!current) {
      current = ((await $.store.get('scoped')) as Scoped | undefined) ?? null
      if (current) {
        const v = current
        if (!same(await read($, scoped), v)) await update($, scoped, () => v)
      }
    }
    if ((current && now - current.fetchedAt < STALE_MS) || !mayFetch(scopedFetch, now)) return
    scopedFetch.now = true
    scopedFetch.lastTry = now
    try {
      // The login Claude Code saved (absent on macOS, which keeps it in the Keychain).
      const dir = await configDir($)
      if (!dir) return
      const creds = JSON.parse(await $.fs.read(`${dir}/.credentials.json`)) as { claudeAiOauth?: { accessToken?: string } }
      const token = creds.claudeAiOauth?.accessToken
      if (!token) return
      const r = await $.http.fetch(USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'session-panel' },
      })
      // A 401 means the login was renewed since it was read: the next try reads the new one.
      if (!r.ok) return
      type Row = { kind?: string; percent?: number; resets_at?: string; scope?: { model?: { display_name?: string } } }
      const rows = (JSON.parse(r.text) as { limits?: Row[] }).limits ?? []
      const limits: Limit[] = rows
        .filter(l => l.kind === 'weekly_scoped' && l.scope?.model && typeof l.percent === 'number')
        .map(l => ({
          label: (l.scope?.model?.display_name ?? 'model').toLowerCase(),
          percent: l.percent ?? 0,
          resetsAt: l.resets_at ? Date.parse(l.resets_at) : undefined,
          isModel: true,
        }))
      const v: Scoped = { fetchedAt: now, limits }
      await $.store.set('scoped', v)
      if (!same(await read($, scoped), v)) await update($, scoped, () => v)
    } finally {
      scopedFetch.now = false
    }
  } catch {
    // Offline: the last figures stay up until they are MAX_AGE_MS old.
  }
}

// ---- Context window --------------------------------------------------------

// Matched against the row names /context prints; first hit wins.
const PALETTE: [RegExp, string, string][] = [
  [/mcp/i, 'mcp tools', '#a78bfa'],
  [/system prompt/i, 'system prompt', '#6b9bd8'],
  [/tool/i, 'tools', '#5bbcc8'],
  [/agent/i, 'agents', '#86c58a'],
  [/memory/i, 'memory files', '#e6c46a'],
  [/skill/i, 'skills', '#f0a0b8'],
  [/message/i, 'messages', '#e07a5f'],
  [/command/i, 'commands', '#c9a27e'],
]
export const label = (name: string) => PALETTE.find(([re]) => re.test(name))?.[1] ?? name.toLowerCase()
const colorOf = (name: string) => PALETTE.find(([re]) => re.test(name))?.[2] ?? '#9aa4b2'

// The breakdown costs a local estimate, so it is redone only once the context moved this far.
export const BREAKDOWN_STEP = 20_000
export const needsBreakdown = (b: Breakdown | null, tokens: number) =>
  b === null || Math.abs(tokens - b.tokens) >= BREAKDOWN_STEP

// The context bar in segments, one per category in its legend colour, each sized by its
// share of the breakdown (counted less often than the total moves, so shares, not counts).
export const segments = (rows: { name: string; tokens: number }[], cells: number) => {
  const total = rows.reduce((n, r) => n + r.tokens, 0)
  if (total === 0 || cells <= 0) return []
  const exact = rows.map(r => (r.tokens / total) * cells)
  const out = exact.map(Math.floor)
  let left = cells - out.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  for (const [, i] of order) {
    if (left <= 0) break
    out[i] = (out[i] ?? 0) + 1
    left -= 1
  }
  return rows.map((r, i) => ({ name: r.name, cells: out[i] ?? 0 })).filter(seg => seg.cells > 0)
}

// The fill as the last response reported it; none before a session's first response.
export const snapshotOf = (c: SessionContextUsage): Snapshot | null =>
  c.tokens === undefined ? null
  : { tokens: c.tokens, window: c.window, percent: c.percent ?? Math.round((c.tokens / c.window) * 100) }

let isCounting = false
const loadBreakdown = async ($: EngineInterface) => {
  if (isCounting) return
  isCounting = true
  try {
    const { context } = await $.session.usage({ breakdown: 'summary' })
    const b = context.breakdown
    if (b) {
      const v: Breakdown = {
        tokens: context.tokens ?? b.totalTokens,
        rows: b.categories.filter(c => c.kind === 'used' && c.tokens > 0).map(c => ({ name: c.name, tokens: c.tokens })),
      }
      if (!same(await read($, breakdown), v)) await update($, breakdown, () => v)
      // Before the first response the bar draws from the breakdown's estimate, so a new
      // session shows it at once; the first reported fill replaces it.
      const s = snapshotOf(context) ?? {
        tokens: b.totalTokens, window: context.window,
        percent: Math.round((b.totalTokens / context.window) * 100), isEstimate: true,
      }
      if (!(await read($, snapshot))) await update($, snapshot, current => current ?? s)
    }
  } catch {
    // The card keeps the last breakdown.
  } finally {
    isCounting = false
  }
}

const badge = (percent: number) => (percent < 50 ? '#86c58a' : percent < 80 ? '#e6c46a' : '#e07a5f')

export const gitText = (g: Git) =>
  `${g.name}${g.branch === undefined ? ' (no git)' : ` ${g.branch}`}${g.changes > 0 ? ` (${g.changes})` : ''}`

// ---- Subagents -------------------------------------------------------------

// Clawd, Claude Code's mascot, three rows tall; its legs shuffle each second while it works.
const CLAWD_TOP = ' ▐▛███▜▌ '
const CLAWD_BODY = '▝▜█████▛▘'
const CLAWD_LEGS = ['  ▘▘ ▝▝  ', '   ▘▘ ▝▝ ']
const CLAWD_WIDTH = 9

// Each agent's Clawd wears its own hat, two rows tall, so two agents side by side never look alike.
export const HATS: { name: string; rows: [string, string]; color: string }[] = [
  { name: 'baseball cap', rows: ['   ▄▄▄   ', '  ▐███▄▄ '], color: '#61afef' },
  { name: 'top hat', rows: ['  ▐███▌  ', ' ▀▀▀▀▀▀▀ '], color: '#d0d0d0' },
  { name: 'party hat', rows: ['    ●    ', '   ▟█▙   '], color: '#ff79c6' },
  { name: 'crown', rows: ['  ▗ ▄ ▖  ', '  █████  '], color: '#ffd700' },
  { name: 'cowboy hat', rows: ['  ▗▄▄▄▖  ', '▝▀█████▀▘'], color: '#c9a27e' },
  { name: 'wizard hat', rows: ['     ▄▖  ', '  ▗▟█▙   '], color: '#bd93f9' },
  { name: 'beanie', rows: ['   ▗▄▖   ', '  ▟███▙  '], color: '#50fa7b' },
  { name: 'propeller cap', rows: ['   ━╋━   ', '   ▟█▙   '], color: '#f1fa8c' },
  { name: 'chef hat', rows: ['  ▟███▙  ', '   ███   '], color: '#f8f8f2' },
]

// A hat from the agent's id, moved along to the next free one if an agent on screen wears it.
export const pickHat = (id: string, others: readonly Agent[]) => {
  const taken = new Set(others.map(a => a.hat))
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  for (let i = 0; i < HATS.length; i++) {
    const hat = (h + i) % HATS.length
    if (!taken.has(hat)) return hat
  }
  return h % HATS.length
}
const AGENT_COLOR: Record<Agent['status'], string> = {
  running: '#d77757', done: '#5c6370', failed: '#ff5555', stopped: '#5c6370',
}
// A finished agent stays in the panel this long, then leaves.
const AGENT_LINGER_MS = 3 * MINUTE
const MAX_AGENTS = 5
// The context window of a model the panel cannot ask about.
const DEFAULT_WINDOW = 200_000

// A line cut at its end to fit.
export const clip = (text: string, width: number) =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

export const fmtElapsed = (ms: number) => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, '0')}s`
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`
}

// What a tool call is about, in a few words: its file, pattern, command or query.
export const activityOf = (name: string, input: unknown) => {
  const i = (input ?? {}) as Record<string, unknown>
  const str = (k: string) => (typeof i[k] === 'string' ? (i[k] as string) : '')
  const target =
    str('file_path') ? baseName(str('file_path'))
    : str('notebook_path') ? baseName(str('notebook_path'))
    : str('pattern') ? `"${str('pattern')}"`
    : str('description') ? str('description')
    : str('command') ? (str('command').split('\n')[0] ?? '')
    : str('query') ? `"${str('query')}"`
    : str('url') ? (str('url').replace(/^https?:\/\//, '').split('/')[0] ?? '')
    : str('subject') ? str('subject')
    : ''
  const tool = name.startsWith('mcp__') ? name.split('__').slice(2).join('__') || name : name
  return target ? `${tool} ${target}` : tool
}

// Progress from the agent's own to-do list: TodoWrite rewrites the whole list, while the
// task tools add one at a time and mark each done.
export const planAfter = (a: Agent, uses: readonly { name: string; input: unknown }[]) => {
  let plan = a.plan
  let doneTasks = a.doneTasks ?? []
  for (const u of uses) {
    const i = (u.input ?? {}) as Record<string, unknown>
    if (u.name === 'TodoWrite' && Array.isArray(i.todos)) {
      const todos = i.todos as { status?: string }[]
      plan = { done: todos.filter(t => t.status === 'completed').length, total: todos.length }
    } else if (u.name === 'TaskCreate') {
      plan = { done: plan?.done ?? 0, total: (plan?.total ?? 0) + 1 }
    } else if (u.name === 'TaskUpdate' && typeof i.taskId === 'string') {
      const done = plan?.done ?? 0
      if (i.status === 'completed' && !doneTasks.includes(i.taskId)) {
        doneTasks = [...doneTasks, i.taskId]
        plan = { done: done + 1, total: Math.max(plan?.total ?? 0, done + 1) }
      } else if (i.status === 'deleted' && plan) {
        plan = { ...plan, total: Math.max(plan.done, plan.total - 1) }
      }
    }
  }
  return { plan, doneTasks }
}

// A rough time to finish from the pace so far, once a step of its plan is done.
export const etaMs = (a: Agent, now: number) => {
  const p = a.plan
  if (!p || p.done === 0 || p.done >= p.total) return null
  return ((now - a.startedAt) / p.done) * (p.total - p.done)
}

// A model with "[1m]" has the million-token window; the main loop's model has the window
// the session measured; any other model the usual 200k.
export const agentWindow = (a: Agent, main: Model | null, s: Snapshot | null) =>
  a.model?.includes('[1m]') ? 1_000_000
  : a.model && s && main && modelName(a.model) === main.name ? s.window
  : DEFAULT_WINDOW

// Running agents first, then the most recent.
export const agentOrder = (list: readonly Agent[]) =>
  [...list].sort((a, b) =>
    (a.status === 'running' ? 0 : 1) - (b.status === 'running' ? 0 : 1) || b.startedAt - a.startedAt)

// Loops with an id the agent list does not name (a workflow's, the engine's own forks)
// are not subagents the person started: looked up once, then left alone.
const notAgents = new Set<string>()
// The one-second timer: running only while an agent does, since each tick is a dispatch.
let second: Timer | null = null
let pulses = 0

const startPulse = ($: EngineInterface) => {
  second ??= $.clock.every(1000, () => void pulse($).catch(() => undefined))
}

const ensureAgent = async ($: EngineInterface, id: string, now: number) => {
  if (notAgents.has(id) || (await read($, agents)).some(a => a.id === id)) return
  let infos
  try {
    infos = await $.agent.list()
  } catch {
    // A failed lookup says nothing about the id: the next step asks again.
    return
  }
  const info = infos.find(a => a.id === id)
  if (!info) {
    notAgents.add(id)
    return
  }
  const a: Agent = { id, description: info.description, type: info.type, status: 'running', startedAt: now, steps: 0, tools: 0, output: 0 }
  await update($, agents, list => (list.some(x => x.id === id) ? list : [...list, { ...a, hat: pickHat(id, list) }]))
}

const recordStep = async ($: EngineInterface, id: string, modelId: string, r: TurnStepResult) => {
  const now = await $.clock.now()
  await ensureAgent($, id, now)
  const u = r.usage
  const last = r.toolUses[r.toolUses.length - 1]
  await update($, agents, list => list.map(a => (a.id !== id ? a : {
    ...a,
    // The last step of a turn can be recorded after the turn's end was: that end stands.
    // Any other step means the agent is at work, a teammate's next turn included.
    ...(a.endedTurn === r.turnId ? {} : { status: 'running' as const, endedAt: undefined, endedTurn: undefined }),
    model: modelId,
    steps: a.steps + 1,
    tools: a.tools + r.toolUses.length,
    activity: last ? activityOf(last.name, last.input) : 'writing its answer',
    context: u ? u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens : a.context,
    output: a.output + (u?.output_tokens ?? 0),
    ...planAfter(a, r.toolUses),
  })))
  startPulse($)
}

const ENDED: Partial<Record<string, Agent['status']>> = { completed: 'done', failed: 'failed', killed: 'stopped' }

// Each second while an agent runs: the clocks move on. Every fifth, the engine's own list
// catches an agent that ended without a last turn (stopped by the person, say).
const pulse = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, tick, () => now)
  pulses += 1
  const infos = pulses % 5 === 0 ? await $.agent.list().catch(() => []) : []
  const settle = (list: Agent[]) => list
    .map(a => {
      const ended = a.status === 'running' ? ENDED[infos.find(x => x.id === a.id)?.status ?? ''] : undefined
      return ended ? { ...a, status: ended, endedAt: now, activity: undefined } : a
    })
    .filter(a => a.status === 'running' || now - (a.endedAt ?? now) < AGENT_LINGER_MS)
  // Written from the value as it stands at the write, so a spawn or a step in between is kept.
  const list = await read($, agents)
  if (!same(list, settle(list))) await update($, agents, settle)
  if (!(await read($, agents)).some(a => a.status === 'running')) {
    second?.cancel()
    second = null
  }
}

// ---- Hooks -----------------------------------------------------------------

// /clear starts the session's values over without loading the module again, so
// session.start alone cannot be trusted to have filled them: whatever is empty when a
// turn is measured is loaded again (each loader keeps to its own pace).
const refill = async ($: EngineInterface, limits: readonly SessionRateLimit[]) => {
  const [m, g, w, sc, rl] = await Promise.all([read($, model), read($, git), read($, weather), read($, scoped), read($, rate)])
  if (!m) void loadModel($)
  if (!g) void loadGit($)
  if (!w) void loadWeather($)
  if (!sc) void loadScoped($)
  if (rl.length === 0) {
    const v = toLimits(limits)
    if (v.length > 0) await update($, rate, () => v)
  }
}

const openPane = ($: EngineInterface) => $.ui.open({ id: PANE, title: PANE_TITLE, columns: PANE_COLUMNS })

export const register: Register = on => {
  let responded = false

  on('session.start', async ($, e, next) => {
    const [now, usage] = await Promise.all([$.clock.now(), $.session.usage()])
    await update($, tick, () => now)
    {
      const v = toLimits(usage.rateLimits)
      if (!same(await read($, rate), v)) await update($, rate, () => v)
    }
    // A resumed session may already know its fill: the bar draws before the next turn.
    {
      const s = snapshotOf(usage.context)
      if (s && !same(await read($, snapshot), s)) await update($, snapshot, () => s)
    }

    // Nothing here waits on git, node or the network: the session starts at once.
    void loadModel($)
    void loadGit($)
    // A reload or a resumed session has no breakdown yet: count it now, not a turn from now.
    void read($, breakdown).then(b => (b ? undefined : loadBreakdown($)))
    void loadScoped($)
    void loadWeather($)
    void (async () => {
      const stored = await $.store.get('cacheTtl')
      ttlMs = typeof stored === 'number' ? stored : null
      // A resumed session's cache may still be warm: its transcript says when it was last used.
      if ((await $.session.turns()) > 0) await readTranscriptCache($)
    })().catch(() => undefined)

    // Once a minute: the countdowns move on, and stale figures refresh.
    $.clock.every(MINUTE, () => {
      void pulse($).catch(() => undefined)
      void loadScoped($)
      void loadWeather($)
      void loadGit($)
    })
    // Once a second, only while a subagent runs: its time on task moves on. A reload
    // cancels the old timer, so one left running needs starting again.
    void read($, agents).then(list => (list.some(a => a.status === 'running') ? startPulse($) : undefined))

    // Opened unasked, the engine docks it only on a wide terminal; /dash opens it at any width.
    void $.command.register({ name: 'dash', description: 'Show or hide the session panel: repo, context, usage, weather and subagents' })
      .catch(() => undefined)
    void openPane($).catch(() => undefined)

    return next(e)
  })

  on('command.run', { command: 'dash' }, async $ => {
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane?.isPlaced && pane.isShown) {
      await $.ui.close({ id: PANE })
      return { text: 'Session panel closed.' }
    }
    const opened = await openPane($)
    return { text: opened.isPlaced ? 'Session panel opened.' : `Session panel waits: ${opened.reason}` }
  })

  // Each main-thread request refreshes the prompt cache; the first of a turn names the
  // model and effort in use.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      responded = true
      if (e.index === 0) {
        const m: Model = { name: modelName(e.model), effort: typeof e.effort === 'string' ? e.effort : undefined }
        // Compared with what is kept, not with what this module last wrote: /clear
        // empties the kept value while the module lives on.
        void read($, model).then(current => (same(current, m) ? undefined : update($, model, () => m)))
      }
      return yield* next(e)
    }

    // A subagent's request: what it used, what it asked for, how far through its plan it is.
    const agentId = e.agentId
    const r = yield* next(e)
    void recordStep($, agentId, e.model, r).catch(() => undefined)
    return r
  })

  // Following an agent never stands in the way of starting one: whatever went wrong here,
  // the spawn goes on as the engine settled it.
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    // A workflow's agents are its own business, and can number in the dozens.
    if (e.workflow || !('agentId' in r) || !r.agentId) return r
    const id = r.agentId
    const now = await $.clock.now()
    await update($, agents, list => {
      const existing = list.find(x => x.id === id)
      // Resumed, or its first step got here first: the same card goes on, hat and all.
      if (existing) {
        return list.map(x => (x.id !== id ? x : {
          ...x, description: e.description, type: e.subagentType, model: r.model,
          status: 'running' as const, endedAt: undefined, endedTurn: undefined,
        }))
      }
      const a: Agent = {
        id, description: e.description, type: e.subagentType, model: r.model, status: 'running',
        startedAt: now, steps: 0, tools: 0, output: 0, hat: pickHat(id, list),
      }
      return [...list, a]
    }).catch(() => undefined)
    startPulse($)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const id = e.agentId
      const status: Agent['status'] =
        e.isAborted || e.reason === 'aborted' ? 'stopped'
        : e.reason === 'error' || e.reason === 'refusal' ? 'failed'
        : 'done'
      const turnId = e.turnId
      void $.clock.now()
        .then(now => update($, agents, list =>
          list.map(a => (a.id === id ? { ...a, status, endedAt: now, endedTurn: turnId, activity: undefined } : a))))
        .catch(() => undefined)
    }
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    void refill($, e.rateLimits).catch(() => undefined)
    if (e.changed.includes('rateLimits')) {
      {
        const v = toLimits(e.rateLimits)
        if (!same(await read($, rate), v)) await update($, rate, () => v)
      }
    }

    // A turn just ended: the cache was used and files may have changed.
    if (responded) {
      responded = false
      void markCached($)
      void loadGit($)
    }

    const s = e.changed.includes('context') ? snapshotOf(e.context) : null
    if (s) {
      const { tokens, window } = s
      const before = (await read($, snapshot))?.tokens ?? 0
      {
        const v = s
        if (!same(await read($, snapshot), v)) await update($, snapshot, () => v)
      }

      if (needsBreakdown(await read($, breakdown), tokens)) void loadBreakdown($)

      // A warning before the window fills, whether or not auto-compaction would step in.
      if (before < window * 0.9 && tokens >= window * 0.9) {
        $.ui.toast(`Context is ${fmt(tokens)} of ${fmt(window)}`)
      }
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // Every read at once; the countdowns draw against the minute's tick, not a clock call.
    const [s, m, g, w, c, rl, sc, t, bd, ag] = await Promise.all([
      read($, snapshot), read($, model), read($, git), read($, weather),
      read($, cache), read($, rate), read($, scoped), read($, tick), read($, breakdown), read($, agents),
    ])
    const now = Math.max(t, await $.clock.now())
    const limits = [
      ...rl,
      ...(sc && now - sc.fetchedAt < MAX_AGE_MS ? sc.limits : []),
    ]

    const { Box, Text, Button } = $.ui.resolve(e)

    if (!s && !m && !g && !w && !c && limits.length === 0 && ag.length === 0) {
      return <Text dimColor>Waiting for the first turn…</Text>
    }

    const columns = e.props.bodyColumns
    const isTerminal = e.surface === 'terminal'
    const meterSvg = (percent: number, color: string, alt: string) => {
      if (e.surface === 'terminal') return null
      const { Svg } = $.ui.resolve(e)
      return <Svg source={svgMeter(percent, color)} alt={alt} height={12} />
    }
    // A meter: block cells on the terminal, a drawn bar elsewhere.
    const bar = (percent: number, width: number, color: string, alt: string) => {
      if (!isTerminal) return <Box flexGrow={1}>{meterSvg(percent, color, alt)}</Box>
      const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)
      return (
        <Text>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text color={FREE}>{'█'.repeat(width - filled)}</Text>
        </Text>
      )
    }
    const heading = (text: string, extra?: string) => (
      <Text>
        <Text bold color={HEADING}>{text}</Text>
        {extra ? <Text dimColor> · {extra}</Text> : null}
      </Text>
    )

    // ---- Repository, branch and its uncommitted files, then model and effort
    const files = g?.files ?? []
    const header = g || m ? (
      <Box flexDirection="column">
        {g ? (
          <Text>
            <Text bold color="#8be9fd">{g.name}</Text>
            {g.branch === undefined
              ? <Text color="#b4b4b4"> (no git)</Text>
              : <Text color={g.isDetached ? '#ffb86c' : '#50fa7b'}> {g.branch}</Text>}
            {g.branch === undefined ? null
              : files.length > 0 ? <Text color="#b4b4b4"> · {files.length} uncommitted</Text>
              : <Text dimColor> · clean</Text>}
          </Text>
        ) : null}
        {files.slice(0, MAX_FILES).map(f => {
          const letter = fileLetter(f.code)
          return (
            <Text key={`file-${f.path}`}>
              <Text color={FILE_COLOR[letter] ?? '#b4b4b4'}>{letter} </Text>
              <Text color="#b4b4b4">{tailPath(f.path, Math.max(8, columns - 2))}</Text>
            </Text>
          )
        })}
        {files.length > MAX_FILES ? <Text dimColor>  +{files.length - MAX_FILES} more</Text> : null}
        {m ? (
          <Text>
            <Text color={MODEL_COLOR}>{m.name}</Text>
            {m.effort ? <Text color={EFFORT_COLOR[m.effort] ?? '#b4b4b4'}> [{m.effort}]</Text> : null}
          </Text>
        ) : null}
      </Box>
    ) : null

    // ---- Context: the bar, the totals, and what fills it, largest first, then the cache:
    // once it lapses, the whole context is sent again at full price.
    const cacheMeter = c ? meters([cacheLimit(c, now)], columns, now)[0] : undefined
    const cacheRow = cacheMeter ? (
      <Box flexDirection="row" alignItems="center">
        <Text color={LIMIT_LABEL.cache}>{cacheMeter.label} </Text>
        {isTerminal ? (
          <Text>
            <Text color={cacheMeter.color}>{'█'.repeat(cacheMeter.filled)}</Text>
            <Text color={FREE}>{'█'.repeat(cacheMeter.empty)}</Text>
          </Text>
        ) : (
          <Box flexGrow={1}>
            {meterSvg(cacheMeter.limit.percent, cacheMeter.color, `cache ${Math.round(cacheMeter.limit.percent)}% left`)}
          </Box>
        )}
        <Text> {cacheMeter.pct}</Text>
        {!cacheMeter.reset ? null
          : cacheMeter.limit.isWarning ? <Text color={cacheMeter.color}> {cacheMeter.reset}</Text>
          : <Text dimColor> {cacheMeter.reset}</Text>}
      </Box>
    ) : null
    let context = null
    if (!s && cacheRow) {
      // No snapshot yet: the cache alone, under its section.
      context = (
        <Box flexDirection="column">
          {heading('Context')}
          {cacheRow}
        </Box>
      )
    }
    if (s) {
      const pct = ` ${s.percent}% `
      const barWidth = Math.max(4, columns - pct.length - 1)
      const filled = Math.round((Math.max(0, Math.min(100, s.percent)) / 100) * barWidth)
      const rows = [...(bd?.rows ?? [])].sort((a, b) => b.tokens - a.tokens)
      const nameWidth = Math.max(4, columns - 2 - 7)
      // Coloured by what fills it; the list below is its legend.
      const segs = segments(rows, filled)
      context = (
        <Box flexDirection="column">
          {heading('Context', `${s.isEstimate ? '~' : ''}${fmt(s.tokens)} of ${fmt(s.window)}`)}
          <Box flexDirection="row" alignItems="center">
            {isTerminal ? (
              <Text>
                {segs.length === 0
                  ? <Text color={badge(s.percent)}>{'█'.repeat(filled)}</Text>
                  : segs.map(seg => <Text key={`seg-${seg.name}`} color={colorOf(seg.name)}>{'█'.repeat(seg.cells)}</Text>)}
                <Text color={FREE}>{'█'.repeat(barWidth - filled)}</Text>
              </Text>
            ) : (
              <Box flexGrow={1}>
                {meterSvg(s.percent, badge(s.percent), `Context ${s.percent}% full`)}
              </Box>
            )}
            <Text> </Text>
            <Text bold color="#111111" backgroundColor={badge(s.percent)}>{pct}</Text>
          </Box>
          {rows.length === 0 ? <Text dimColor>counting…</Text> : null}
          {rows.map(r => (
            <Text key={`ctx-${r.name}`}>
              <Text color={colorOf(r.name)}>■ </Text>
              <Text color="#b4b4b4">{label(r.name).slice(0, nameWidth).padEnd(nameWidth)}</Text>
              <Text bold>{fmt(r.tokens).padStart(7)}</Text>
            </Text>
          ))}
          {cacheRow}
        </Box>
      )
    }

    // ---- Usage: one allowance per row, the bars in line
    let usage = null
    if (limits.length > 0) {
      usage = (
        <Box flexDirection="column">
          {heading('Usage')}
          {meters(limits, columns, now).map(meter => (
            <Box key={`limit-${meter.limit.label}`} flexDirection="row" alignItems="center">
              <Text color={meter.limit.isModel ? MODEL_LABEL : LIMIT_LABEL[meter.limit.label] ?? '#9aa4b2'}>{meter.label} </Text>
              {isTerminal ? (
                <Text>
                  <Text color={meter.color}>{'█'.repeat(meter.filled)}</Text>
                  <Text color={FREE}>{'█'.repeat(meter.empty)}</Text>
                </Text>
              ) : (
                <Box flexGrow={1}>
                  {meterSvg(meter.limit.percent, meter.color, `${meter.limit.label} ${Math.round(meter.limit.percent)}% used`)}
                </Box>
              )}
              <Text> {meter.pct}</Text>
              {!meter.reset ? null
                : meter.limit.isWarning ? <Text color={meter.color}> {meter.reset}</Text>
                : <Text dimColor> {meter.reset}</Text>}
            </Box>
          ))}
        </Box>
      )
    }

    // ---- Weather: now, then a row per day, each day's low-to-high on the week's scale
    let forecast = null
    if (w) {
      const min = Math.min(...w.days.map(d => d.lo))
      const max = Math.max(...w.days.map(d => d.hi))
      const strip = stripWidth(columns)
      forecast = (
        <Box flexDirection="column">
          {heading('Weather', w.place || undefined)}
          <Text>
            <Text>{icon(w.code, w.isDay)} </Text>
            <Text bold color={tempColor(w.temp)}>{deg(w.temp)}</Text>
            <Text dimColor> now</Text>
          </Text>
          {w.days.map((d, i) => (
            <Text key={`day-${d.date}`}>
              <Text bold={i === 0} dimColor={i !== 0}>{weekday(d.date)} </Text>
              <Text>{icon(d.code)}</Text>
              <Text color="#7dcfff">{rainText(d)}</Text>
              <Text> </Text>
              <Text color={tempColor(d.lo)}>{deg(d.lo).padStart(4)}</Text>
              <Text> </Text>
              {span(d, min, max, strip).map((cell, k) => (
                <Text key={`s${k}`} color={cell.color}>{cell.char}</Text>
              ))}
              <Text> </Text>
              <Text color={tempColor(d.hi)}>{deg(d.hi).padStart(4)}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    // ---- Subagents: Clawd beside each one's task, time on it, progress and context
    let crew = null
    // A finished agent lingers a few minutes; the timer prunes it, the drawing never waits on that.
    const crewList = ag.filter(a => a.status === 'running' || now - (a.endedAt ?? now) < AGENT_LINGER_MS)
    if (crewList.length > 0) {
      const running = crewList.filter(a => a.status === 'running').length
      const width = Math.max(12, columns - CLAWD_WIDTH - 1)
      const frame = Math.floor(now / 1000) % 2
      const shown = agentOrder(crewList).slice(0, MAX_AGENTS)
      crew = (
        <Box flexDirection="column">
          {heading('Agents', running > 0 ? `${running} running` : 'all finished')}
          <Box flexDirection="column" rowGap={1}>
            {shown.map(a => {
              const color = AGENT_COLOR[a.status]
              const hat = HATS[a.hat ?? pickHat(a.id, [])] ?? HATS[0]!
              const elapsed = fmtElapsed((a.endedAt ?? now) - a.startedAt)
              const stateText =
                a.status === 'running' ? elapsed
                : a.status === 'done' ? `done in ${elapsed}`
                : a.status === 'failed' ? `failed after ${elapsed}`
                : `stopped after ${elapsed}`
              const state =
                a.status === 'running' ? <Text color={color}>{stateText}</Text>
                : a.status === 'done' ? <Text color="#86c58a">{stateText}</Text>
                : a.status === 'failed' ? <Text color={color}>{stateText}</Text>
                : <Text dimColor>{stateText}</Text>
              // A finished card can be dismissed before it leaves by itself.
              const isOver = a.status !== 'running'
              // The type, then the model while there is room, beside the state (and its X) on one line.
              const room = Math.max(4, width - stateText.length - 1 - (isOver ? 2 : 0))
              const typeText = clip(a.type, room)
              const modelText = a.model && room - typeText.length > 4
                ? clip(` · ${modelName(a.model)}`, room - typeText.length)
                : ''
              const eta = a.status === 'running' ? etaMs(a, now) : null
              const planText = a.plan
                ? `${a.plan.done}/${a.plan.total} steps${eta === null ? '' : ` · ~${eta < MINUTE ? '<1m' : fmtReset(eta)} left`}`
                : ''
              const win = agentWindow(a, m, s)
              const ctxText = a.context === undefined ? '' : ` ${fmt(a.context)}/${fmt(win)}`
              const ctxPct = a.context === undefined ? 0 : Math.round((a.context / win) * 100)
              return (
                <Box key={`agent-${a.id}`} flexDirection="row" columnGap={1}>
                  <Box flexDirection="column" width={CLAWD_WIDTH} flexShrink={0}>
                    {hat.rows.map((row, k) => (
                      <Text key={`hat${k}`} color={hat.color} dimColor={a.status !== 'running'}>{row}</Text>
                    ))}
                    <Text color={color}>{CLAWD_TOP}</Text>
                    <Text color={color}>{CLAWD_BODY}</Text>
                    <Text color={color}>{CLAWD_LEGS[a.status === 'running' ? frame : 0]}</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1}>
                    <Box flexDirection="row" justifyContent="space-between">
                      <Text>
                        <Text bold>{typeText}</Text>
                        {modelText ? <Text dimColor>{modelText}</Text> : null}
                      </Text>
                      {isOver ? (
                        <Box flexDirection="row" columnGap={1}>
                          {state}
                          <Button
                            key={`dismiss-${a.id}`}
                            label={`Dismiss ${a.type} agent`}
                            plain
                            onPress={() => void update($, agents, list => list.filter(x => x.id !== a.id))}
                          >
                            <Text color="#ff5555">✕</Text>
                          </Button>
                        </Box>
                      ) : state}
                    </Box>
                    <Text>{a.description}</Text>
                    {a.status === 'running' && a.activity ? (
                      <Text>
                        <Text dimColor>now </Text>
                        <Text color="#b4b4b4">{clip(a.activity, width - 4)}</Text>
                      </Text>
                    ) : null}
                    {a.plan && a.plan.total > 0 ? (
                      <Box flexDirection="row" alignItems="center">
                        {bar((a.plan.done / a.plan.total) * 100, Math.max(4, width - planText.length - 1), '#86c58a', `${a.plan.done} of ${a.plan.total} steps done`)}
                        <Text dimColor> {planText}</Text>
                      </Box>
                    ) : null}
                    {a.context === undefined ? null : (
                      <Box flexDirection="row" alignItems="center">
                        <Text dimColor>ctx </Text>
                        {bar(ctxPct, Math.max(4, width - 4 - ctxText.length), badge(ctxPct), `Context ${ctxPct}% full`)}
                        <Text dimColor>{ctxText}</Text>
                      </Box>
                    )}
                    <Text dimColor>
                      {a.tools} {a.tools === 1 ? 'tool call' : 'tool calls'} · {fmt(a.output)} written
                    </Text>
                  </Box>
                </Box>
              )
            })}
            {crewList.length > MAX_AGENTS ? <Text dimColor>+{crewList.length - MAX_AGENTS} more</Text> : null}
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {header}
        {context}
        {usage}
        {forecast}
        {crew}
      </Box>
    )
  })
}
