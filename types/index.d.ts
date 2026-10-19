// How full the context window is: as the last response reported it, or (isEstimate) as the
// breakdown counts it before the first response.
export type Snapshot = { tokens: number; window: number; percent: number; isEstimate?: boolean }

// What fills the context, by category, as of `tokens`: drawn in the hover card.
export type Breakdown = { tokens: number; rows: { name: string; tokens: number }[] }

// One usage allowance: the 5-hour or weekly window, or a single model's weekly share.
export type Limit = {
  label: string
  percent: number
  resetsAt?: number // epoch ms
  isModel?: boolean // a per-model weekly limit, the only kind allowed to turn red
  note?: string // drawn in place of the reset countdown
  color?: string // the bar's colour, in place of the one its percent picks
  isWarning?: boolean // its note is drawn in the bar's colour, not dimmed
}

// When the session's last response was cached, and for how long the cache lives.
export type Cache = { lastAt: number; ttlMs: number }

// Per-model weekly limits, from the account's usage endpoint.
export type Scoped = { fetchedAt: number; limits: Limit[] }

// The main loop's model, as the last request named it, and its effort level.
export type Model = { name: string; effort?: string }

// One uncommitted file: git's two-letter status (index, then working tree; '??' untracked)
// and its path from the repository root.
export type GitFile = { code: string; path: string }

// The repository (or folder) the session runs in, and what is uncommitted on its branch.
export type Git = { name: string; branch?: string; isDetached?: boolean; changes: number; files: GitFile[] }

// A subagent the session started, as the panel follows it.
export type Agent = {
  id: string
  description: string
  type: string
  parentId?: string // the agent that spawned it; absent when the main conversation did
  model?: string // the model id its last request named
  status: 'running' | 'done' | 'failed' | 'stopped'
  startedAt: number // epoch ms
  endedAt?: number
  steps: number // model requests it has made
  tools: number // tool calls it has asked for
  activity?: string // the last tool it asked for, with its target
  context?: number // tokens its last request carried
  output: number // tokens it has written
  // Its own to-do list, when it keeps one: TodoWrite's items, or the tasks it created.
  plan?: { done: number; total: number }
  doneTasks?: string[] // ids of the tasks it marked completed, so a repeat counts once
  hat?: number // which of the panel's hats its Clawd wears, kept while it is on screen
  endedTurn?: string // the turn whose end finished it, so that turn's last step cannot revive it
}

// One day of the forecast, temperatures in °C, rain as the day's highest chance in %.
export type Day = { date: string; code: number; hi: number; lo: number; rain: number }

export type Weather = {
  fetchedAt: number
  place: string
  temp: number
  code: number
  isDay: boolean
  days: Day[]
}

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      snapshot: Snapshot | null
      breakdown: Breakdown | null
      rate: Limit[]
      scoped: Scoped | null
      cache: Cache | null
      model: Model | null
      git: Git | null
      // The whole list of uncommitted files, not just the first few.
      allFiles: boolean
      weather: Weather | null
      agents: Agent[]
      // The moment the countdowns are drawn against: written each minute, and each second
      // while a subagent runs.
      tick: number
    }
  }
}
