import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  activityOf, agentTree, cacheColor, HATS, pickHat, cacheLimit, etaMs, fileLetter, fmt, fmtElapsed, fmtReset, gitText, meters, modelName,
  parseStatus, planAfter, rainText, segments, span, stripWidth, tailPath, tempColor,
} from '../hooks/register'

const PANE = {
  component: 'Pane' as const,
  requestId: 'session-panel',
  props: {
    title: 'Session', isFocused: false, bodyColumns: 44, placement: 'dock' as const,
    scroll: { offset: 0, bodyRows: 40 }, view: {},
  },
}
const START = Date.parse('2026-10-07T14:00:00Z')

test('token counts read short', async () => {
  expect(fmt(4200)).toBe('4.2k')
  expect(fmt(52000)).toBe('52k')
  expect(fmt(1_000_000)).toBe('1M')
})

test('the context bar shows totals and no breakdown on both surfaces', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  mock.clock(on, { now: START })

  await $.session.measure({ context: { tokens: 92000, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /92k of 1M/ })).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).toContain(surface === 'terminal' ? '█' : 'Context 9% full')
    expect(drawn).not.toContain('mcp tools')
    await ui.unmount()
  }
})

describe('usage allowances', () => {
  test('one bar per row, each row the panel width with the bars in line', async () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    const limits = [
      { label: '5h', percent: 22, resetsAt: now + (2 * 60 + 13) * 60000 },
      { label: 'week', percent: 41, resetsAt: now + (4 * 24 + 3) * 3600000 },
      { label: 'fable', percent: 76, resetsAt: now + 5 * 24 * 3600000, isModel: true },
    ]
    const rows = meters(limits, 44, now)
    const longestReset = Math.max(...rows.map(r => r.reset.length))
    for (const r of rows) {
      expect(r.label.length).toBe(5)
      expect(r.label.length + 1 + r.filled + r.empty + 1 + r.pct.length + 1 + longestReset).toBe(44)
    }
    expect(rows[0]!.reset).toBe('2h13m')
    expect(rows[1]!.reset).toBe('4d3h')
    expect(fmtReset(-1)).toBe('now')
  })

  test('the cache drains from full to expired', async () => {
    const now = Date.parse('2026-10-07T12:00:00Z')
    const fresh = cacheLimit({ lastAt: now - 8 * 60000, ttlMs: 3600000 }, now)
    expect(fresh.note).toBe('52m left')
    expect(Math.round(fresh.percent)).toBe(87)
    expect(cacheLimit({ lastAt: now - 59.5 * 60000, ttlMs: 3600000 }, now).note).toBe('<1m left')
    // A response after the minute's tick still reads as a full cache, never more.
    expect(cacheLimit({ lastAt: now + 30000, ttlMs: 3600000 }, now).percent).toBe(100)
    const gone = cacheLimit({ lastAt: now - 2 * 3600000, ttlMs: 3600000 }, now)
    expect(gone.note).toBe('expired')
    expect(gone.percent).toBe(0)
    expect(meters([fresh], 80, now)[0]!.reset).toBe('52m left')
    expect(fresh.isWarning).toBe(false)
    // Coloured by the share of its life left, so a 5-minute cache warns as an hour's does.
    const lapsing = cacheLimit({ lastAt: now - 4 * 60000, ttlMs: 5 * 60000 }, now)
    expect(lapsing.isWarning).toBe(true)
    expect(lapsing.color).toBe(cacheColor(20))
    expect([80, 40, 20, 5].map(cacheColor)).toEqual(['#86c58a', '#e6c46a', '#e8a33d', '#e07a5f'])
  })
})

test('5h, week, fable and cache bars draw from their sources', async ($, on) => {
  const resetsAt = new Date(START + 3 * 3600000).toISOString()
  const rateLimits = [
    { kind: 'five_hour', percentUsed: 22, resetsAt },
    { kind: 'seven_day', percentUsed: 41, resetsAt },
  ]
  const fetched: string[] = []
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits, context: { window: 1_000_000 } } }) as never)
  on('session.turns', () => ({ value: 3 }) as never)
  on('session.id', () => ({ value: 'test-session' }) as never)
  on('env.get', (_, e) => ({ value: (e as { name: string }).name === 'USERPROFILE' ? 'C:/Users/test' : undefined }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.cwd', () => ({ value: 'C:/code/repos' }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('store.set', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: JSON.stringify({ claudeAiOauth: { accessToken: 'token' } }) }) as never)
  on('http.fetch', (_, e) => {
    const url = (e as { url: string }).url
    fetched.push(url)
    const body = url.includes('oauth/usage')
      ? { limits: [{ kind: 'weekly_scoped', percent: 76, resets_at: resetsAt, scope: { model: { display_name: 'Fable' } } }] }
      : {}
    return { value: { status: 200, ok: url.includes('oauth/usage'), headers: {}, text: JSON.stringify(body) } } as never
  })
  // A resumed session: its transcript says the cache was last used 8 minutes ago.
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify({ lastAt: START - 8 * 60000, ttlMs: 3600000 }), stderr: '' } }) as never)
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^5h\s+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^week\s+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^fable\s+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /76%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^cache\s+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /52m left/ })).toBeDefined()
    // The cache sits under Context, not among the allowances.
    const drawn = JSON.stringify(await ui.drawn())
    const at = (text: string) => drawn.indexOf(text)
    expect(at('"Context"')).toBeGreaterThan(-1)
    expect(at('"Context"')).toBeLessThan(at('"cache"'))
    expect(at('"cache"')).toBeLessThan(at('"Usage"'))
    await ui.unmount()
  }

  // Fable is fetched once, not again on the next minute's tick.
  const asked = fetched.filter(u => u.includes('oauth/usage')).length
  await clock.advance(60 * 1000)
  expect(fetched.filter(u => u.includes('oauth/usage')).length).toBe(asked)
})

const W = {
  fetchedAt: 0, place: 'Springfield', temp: 7, code: 2, isDay: true,
  days: [
    { date: '2026-10-07', code: 3, hi: 22.8, lo: 6.7, rain: 1 },
    { date: '2026-10-08', code: 3, hi: 24.7, lo: 11.3, rain: 1 },
    { date: '2026-10-09', code: 51, hi: 17.4, lo: 5.9, rain: 48 },
    { date: '2026-10-10', code: 80, hi: 8.5, lo: 0.2, rain: 67 },
    { date: '2026-10-11', code: 3, hi: 7.9, lo: -3.4, rain: 27 },
  ],
}

describe('header', () => {
  test('model ids read as short family names', async () => {
    expect(modelName('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelName('Opus 5.5')).toBe('Opus 5.5')
  })

  test('one git status gives branch, detached commit and changes', async () => {
    const out = [
      '# branch.oid 1a2b3c4d5e6f', '# branch.head master', '# branch.ab +0 -0',
      '1 .M N... 100644 100644 100644 a b src/my file.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/new.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/both.ts',
      '? notes.md', '',
    ].join('\n')
    expect(parseStatus('repos', out)).toEqual({
      name: 'repos', branch: 'master', isDetached: false, changes: 4,
      files: [
        { code: '.M', path: 'src/my file.ts' },
        { code: 'R.', path: 'src/new.ts' },
        { code: 'UU', path: 'src/both.ts' },
        { code: '??', path: 'notes.md' },
      ],
    })
    expect(['.M', 'R.', 'UU', '??', 'AM'].map(fileLetter)).toEqual(['M', 'R', 'U', '?', 'M'])
    expect(tailPath('src/components/very/deep/derive.ts', 20)).toBe('…very/deep/derive.ts')
    expect(tailPath('a.ts', 20)).toBe('a.ts')
    const detached = parseStatus('repos', '# branch.oid 1a2b3c4d5e6f\n# branch.head (detached)\n')
    expect(detached.branch).toBe('1a2b3c4')
    expect(detached.isDetached).toBe(true)
  })

  test('temperatures run blue to red', async () => {
    expect(tempColor(-30)).toBe('#7aa2f7')
    expect(tempColor(40)).toBe('#f7768e')
    expect(tempColor(5)).toBe('#9ece6a')
  })

  test('a day row fits the panel, rainy or not', async () => {
    expect(rainText(W.days[0]!)).toBe('     ')
    expect(rainText(W.days[2]!)).toBe('  48%')
    expect(rainText({ ...W.days[2]!, rain: 100 })).toBe(' 100%')
    expect(22 + stripWidth(36)).toBe(36)
    expect(stripWidth(80)).toBe(24)
    expect(stripWidth(10)).toBe(4)
  })

  test('the repository reads as name, branch and changes', async () => {
    const g = { name: 'my-app', branch: 'master', changes: 3, isDetached: false, files: [] }
    expect(gitText(g)).toBe('my-app master (3)')
  })

  test('each day spans its own low to high on the week scale', async () => {
    const cold = span(W.days[4]!, -3.4, 24.7, 8).map(c => c.char).join('')
    const warm = span(W.days[1]!, -3.4, 24.7, 8).map(c => c.char).join('')
    expect(cold.startsWith('━')).toBe(true)
    expect(cold.endsWith('─')).toBe(true)
    expect(warm.startsWith('─')).toBe(true)
    expect(warm.endsWith('━')).toBe(true)
  })
})

test('repo, model and forecast draw on both surfaces, git in one process', async ($, on) => {
  const forecast = {
    current: { temperature_2m: 7, weather_code: 2, is_day: 1 },
    daily: {
      time: W.days.map(d => d.date), weather_code: W.days.map(d => d.code),
      temperature_2m_max: W.days.map(d => d.hi), temperature_2m_min: W.days.map(d => d.lo),
      precipitation_probability_max: W.days.map(d => d.rain),
    },
  }
  const where = { nearest_area: [{ latitude: '45.0', longitude: '-100.0', areaName: [{ value: 'Springfield' }] }] }
  const store = new Map<string, unknown>()
  const runs: string[][] = []
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000 } } }) as never)
  on('session.turns', () => ({ value: 0 }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high' } }) as never)
  on('session.repo', () => ({ value: { root: 'C:/code/my-app', remote: null, internal: false } }) as never)
  on('session.cwd', () => ({ value: 'C:/code/my-app' }) as never)
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    runs.push([...argv])
    const stdout = '# branch.oid abc1234\n# branch.head master\n1 .M N... a\n? b.ts\n'
    return { value: { exitCode: 0, stdout, stderr: '' } } as never
  })
  on('fs.read', () => ({ value: '{}' }) as never)
  on('http.fetch', (_, e) => {
    const url = (e as { url: string }).url
    const body = url.includes('wttr.in') ? where : forecast
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } } as never
  })
  on('store.get', (_, e) => ({ value: store.get((e as { key: string }).key) }) as never)
  on('store.set', (_, e) => {
    store.set((e as { key: string }).key, (e as { value: unknown }).value)
    return { value: undefined } as never
  })
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[high\]/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^my-app$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /master/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 uncommitted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^b\.ts$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Springfield/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Fri $/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /67%/ })).toBeDefined()
    await ui.unmount()
  }

  // A new session starts no node process, and git runs once.
  expect(runs.filter(a => a[0] === 'node').length).toBe(0)
  expect(runs.filter(a => a[0] === 'git').length).toBe(1)
})

test('the panel lists what fills the context, largest first', async ($, on) => {
  const cat = (name: string, tokens: number, kind: 'used' | 'free' = 'used') =>
    ({ name, tokens, kind, color: 'inactive', isDeferred: false })
  let counted = 0
  on('session.measure', (_, e) => ({ changed: e.changed }))
  on('session.usage', () => {
    counted += 1
    return { value: {
      startedAt: 0, rateLimits: [],
      context: {
        tokens: 92000, window: 1_000_000, percent: 9,
        breakdown: {
          categories: [cat('System prompt', 4200), cat('MCP tools', 52000), cat('Messages', 31000), cat('Free space', 895000, 'free')],
          totalTokens: 92000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model',
          percentage: 9, gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [],
          autoCompactThreshold: 987000, isAutoCompactEnabled: false, apiUsage: null,
        },
      },
    } } as never
  })
  const clock = mock.clock(on, { now: START })

  await $.session.measure({ context: { tokens: 92000, window: 1_000_000, percent: 9 }, rateLimits: [], changed: ['context'] })
  await clock.settle()
  // A small move does not count the breakdown again.
  await $.session.measure({ context: { tokens: 95000, window: 1_000_000, percent: 10 }, rateLimits: [], changed: ['context'] })
  await clock.settle()
  expect(counted).toBe(1)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /mcp tools/ })).toBeDefined()
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn.indexOf('mcp tools')).toBeLessThan(drawn.indexOf('messages'))
    expect(drawn.indexOf('messages')).toBeLessThan(drawn.indexOf('system prompt'))
    await ui.unmount()
  }
})

// A new session has no reported fill until its first response: the bar draws from the
// breakdown's estimate at once, and the first reported fill replaces it. A resumed session
// that already knows its fill draws it at the start.
describe('the context bar before the first response', () => {
  const start = async (
    ...[$, on, context]: [...Parameters<TestBody>, Record<string, unknown>]
  ) => {
    const breakdown = {
      categories: [{ name: 'System prompt', tokens: 18000, kind: 'used', color: 'inactive', isDeferred: false }],
      totalTokens: 18000, maxTokens: 1_000_000, rawMaxTokens: 1_000_000, autocompactSource: 'model',
      percentage: 2, gridRows: [], model: 'test', memoryFiles: [], mcpTools: [], agents: [],
      isAutoCompactEnabled: false, apiUsage: null,
    }
    on('session.usage', (_, e) => ({ value: {
      startedAt: 0, rateLimits: [],
      context: { window: 1_000_000, ...context, ...((e as { breakdown?: string }).breakdown ? { breakdown } : {}) },
    } }) as never)
    on('session.turns', () => ({ value: 0 }) as never)
    on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
    on('settings.read', () => ({ value: {} }) as never)
    on('session.repo', () => ({ value: null }) as never)
    on('session.cwd', () => ({ value: 'C:/code/my-app' }) as never)
    on('store.get', () => ({ value: undefined }) as never)
    on('fs.read', () => ({ value: '{}' }) as never)
    on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }) as never)
    on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }) as never)
    on('ui.open', () => ({ value: { isPlaced: true } }) as never)
    on('session.measure', (_, e) => ({ changed: e.changed }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    const clock = mock.clock(on, { now: START })
    await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
    await clock.settle()
    return clock
  }

  test('a new session draws the estimate, then the reported fill', async ($, on) => {
    const clock = await start($, on, {})
    let ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /~18k of 1M/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /system prompt/ })).toBeDefined()
    await ui.unmount()

    await $.session.measure({ context: { tokens: 25000, window: 1_000_000, percent: 3 }, rateLimits: [], changed: ['context'] })
    await clock.settle()
    ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /· 25k of 1M/ })).toBeDefined()
    await ui.unmount()
  })

  test('a resumed session draws its reported fill at the start', async ($, on) => {
    await start($, on, { tokens: 92000, percent: 9 })
    const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /· 92k of 1M/ })).toBeDefined()
    await ui.unmount()
  })
})

// /clear empties the session's values without a session.start the module can rely on:
// the next measured turn loads the model, with the per-model effort, and the allowances.
test('a measured turn refills a model and allowances that were emptied', async ($, on) => {
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000 } } }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'medium' } } } }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.cwd', () => ({ value: 'C:/code/my-app' }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('session.measure', (_, e) => ({ changed: e.changed }))
  const clock = mock.clock(on, { now: START })

  const rateLimits = [{ kind: 'five_hour', percentUsed: 12, resetsAt: new Date(START + 3_600_000).toISOString() }]
  await $.session.measure({ context: { tokens: 92000, window: 1_000_000, percent: 9 }, rateLimits, changed: ['context'] })
  await clock.settle()

  const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /^Opus 5\.5$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[medium\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^5h\s+$/ })).toBeDefined()
  await ui.unmount()
})

test('the session opens the panel and /dash shows or hides it', async ($, on) => {
  const opened: unknown[] = []
  const closed: unknown[] = []
  let isUp = false
  on('session.usage', () => ({ value: { startedAt: 0, rateLimits: [], context: { window: 1_000_000 } } }) as never)
  on('session.turns', () => ({ value: 0 }) as never)
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('settings.read', () => ({ value: {} }) as never)
  on('session.repo', () => ({ value: null }) as never)
  on('session.cwd', () => ({ value: 'C:/code/repos' }) as never)
  on('store.get', () => ({ value: undefined }) as never)
  on('fs.read', () => ({ value: '{}' }) as never)
  on('http.fetch', () => ({ value: { status: 500, ok: false, headers: {}, text: '' } }) as never)
  on('command.register', (_, e) => ({ value: { command: (e as { name: string }).name } }) as never)
  on('ui.open', (_, e) => {
    opened.push(e)
    isUp = true
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', (_, e) => {
    closed.push(e)
    isUp = false
    return { value: undefined } as never
  })
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'session-panel', title: 'Session', isShown: true, isFocused: false, isPlaced: true }] : [],
  }) as never)
  const clock = mock.clock(on, { now: START })
  on('session.start', (_, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '.', surface: 'terminal', isInteractive: true } as never)
  await clock.settle()
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'session-panel', columns: 44 })

  expect((await $.command.run({ command: 'dash' } as never)).text).toBe('Session panel closed.')
  expect(closed).toHaveLength(1)
  expect((await $.command.run({ command: 'dash' } as never)).text).toBe('Session panel opened.')
  expect(opened).toHaveLength(2)
})

test('the context bar is split by what fills it, every cell given out', async () => {
  const rows = [{ name: 'MCP tools', tokens: 52000 }, { name: 'Messages', tokens: 31000 }, { name: 'System prompt', tokens: 4200 }]
  const segs = segments(rows, 20)
  expect(segs.reduce((n, seg) => n + seg.cells, 0)).toBe(20)
  expect(segs.map(seg => seg.name)).toEqual(['MCP tools', 'Messages', 'System prompt'])
  expect(segments(rows, 0)).toEqual([])
  expect(segments([], 10)).toEqual([])
})

describe('subagents', () => {
  const agent = { id: 'a', description: 'd', type: 'Explore', status: 'running' as const, startedAt: 0, steps: 0, tools: 0, output: 0 }

  test('a tool call reads as what it is about', async () => {
    expect(activityOf('Grep', { pattern: 'requireAuth' })).toBe('Grep "requireAuth"')
    expect(activityOf('Read', { file_path: 'C:/code/src/app.ts' })).toBe('Read app.ts')
    expect(activityOf('Bash', { command: 'npm test\nmore', description: 'Run the tests' })).toBe('Bash Run the tests')
    expect(activityOf('Bash', { command: 'npm test\nmore' })).toBe('Bash npm test')
    expect(activityOf('mcp__github__search_issues', {})).toBe('search_issues')
  })

  test('progress comes from its to-do list, and the pace gives a rough finish', async () => {
    const todos = planAfter(agent, [{ name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }] } }])
    expect(todos.plan).toEqual({ done: 1, total: 3 })
    expect(etaMs({ ...agent, plan: todos.plan }, 60_000)).toBe(120_000)
    expect(etaMs({ ...agent, plan: { done: 0, total: 3 } }, 60_000)).toBe(null)

    let a = { ...agent, ...planAfter(agent, [{ name: 'TaskCreate', input: {} }, { name: 'TaskCreate', input: {} }]) }
    expect(a.plan).toEqual({ done: 0, total: 2 })
    a = { ...a, ...planAfter(a, [{ name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }]) }
    a = { ...a, ...planAfter(a, [{ name: 'TaskUpdate', input: { taskId: '1', status: 'completed' } }]) }
    expect(a.plan).toEqual({ done: 1, total: 2 })
    expect(fmtElapsed(134_000)).toBe('2m14s')
    expect(fmtElapsed(42_000)).toBe('42s')
  })

  test('a subagent is drawn from its spawn, through its steps, to done', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-1' }))
    on('agent.list', () => ({ value: [] }) as never)
    on('turn.step', async function* (_, e) {
      return {
        turnId: e.turnId, index: e.index, answer: '', stopReason: 'tool_use' as const,
        toolUses: [
          { id: 't1', name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }, { status: 'pending' }] } },
          { id: 't2', name: 'Grep', input: { pattern: 'requireAuth' } },
        ],
        usage: { model: 'claude-haiku-4-5', input_tokens: 2000, output_tokens: 900, cache_read_input_tokens: 40000, cache_creation_input_tokens: 3000 },
      }
    })
    on('turn.complete', () => ({ text: 'ok' }) as never)

    await $.agent.spawn({ prompt: 'Find auth', description: 'Find auth middleware', subagentType: 'Explore' } as never)
    const stream = $.turn.step({ turnId: 'turn-1', index: 0, model: 'claude-haiku-4-5', messageCount: 1, agentId: 'agent-1' })
    for await (const _ of stream) { /* read to its end */ }
    await stream.result
    await clock.advance(134_000)
    await clock.settle()

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Haiku 4\.5/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^Find auth middleware$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /Grep "requireAuth"/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\/3 steps · ~4m left/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /45k\/200k/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2m1\ds/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 running/ })).toBeDefined()
      await ui.unmount()
    }

    await $.turn.complete({ turnId: 'turn-1', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-1' } as never)
    await clock.settle()
    const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /done in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /all finished/ })).toBeDefined()
    await ui.unmount()

    // A late last step of the finished turn does not bring it back to running.
    const late = $.turn.step({ turnId: 'turn-1', index: 1, model: 'claude-haiku-4-5', messageCount: 2, agentId: 'agent-1' })
    for await (const _ of late) { /* read to its end */ }
    await late.result
    await clock.settle()
    const after = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await after.find({ type: 'Text', text: /done in/ })).toBeDefined()
    await after.unmount()

    // A finished agent leaves the panel a few minutes later.
    await clock.advance(4 * 60_000)
    await clock.settle()
    const later = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(JSON.stringify(await later.drawn())).not.toContain('Find auth middleware')
    await later.unmount()
  })
})

test('agents on screen together never share a hat, and each keeps its own', async () => {
  const base = { description: 'd', type: 'Explore', status: 'running' as const, startedAt: 0, steps: 0, tools: 0, output: 0 }
  const crew: { id: string; hat: number }[] = []
  for (let i = 0; i < HATS.length; i++) {
    const id = `agent-${i}`
    crew.push({ id, hat: pickHat(id, crew.map(c => ({ ...base, ...c }))) })
  }
  expect(new Set(crew.map(c => c.hat)).size).toBe(HATS.length)
  expect(pickHat('agent-3', [])).toBe(pickHat('agent-3', []))
  for (const hat of HATS) for (const row of hat.rows) expect(row.length).toBe(9)
})

test('a finished agent can be dismissed with its X before it leaves by itself', async ($, on) => {
  const clock = mock.clock(on, { now: START })
  on('agent.spawn', () => ({ model: 'claude-haiku-4-5', agentId: 'agent-x' }))
  on('agent.list', () => ({ value: [] }) as never)
  on('turn.complete', () => ({ text: 'ok' }) as never)
  await $.agent.spawn({ prompt: 'p', description: 'Tidy up', subagentType: 'Explore' } as never)
  await $.turn.complete({ turnId: 't', answer: 'ok', durationMs: 1, isAborted: false, reason: 'answer', agentId: 'agent-x' } as never)
  await clock.settle()

  // Drawn on both surfaces; dismissed last, from the terminal.
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Tidy up$/ })).toBeDefined()
    if (surface === 'terminal') {
      await ui.press({ key: 'dismiss-agent-x' })
      expect(JSON.stringify(await ui.drawn())).not.toContain('Tidy up')
    }
    await ui.unmount()
  }
})

test('an agent card opens its transcript, and the path at the top leads back up', async ($, on) => {
  mock.clock(on, { now: START })
  on('agent.spawn', (_, e) => ({ model: 'claude-haiku-4-5', agentId: e.parentAgentId ? 'agent-c' : 'agent-p' }))
  on('agent.list', () => ({ value: [] }) as never)
  const views: (string | undefined)[] = []
  on('ui.view', (_, e) => (views.push(e.agentId), { value: {} }) as never)
  await $.agent.spawn({ prompt: 'p', description: 'Plan the move', subagentType: 'general-purpose' } as never)
  await $.agent.spawn({ prompt: 'p', description: 'Find callers', subagentType: 'Explore', parentAgentId: 'agent-p' } as never)

  const main = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
  expect(await main.find({ type: 'Text', text: /← main/ })).toBeUndefined()
  await main.press({ key: 'view-agent-c' })
  expect(views).toEqual(['agent-c'])
  await main.unmount()

  const inChild = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE, props: { ...PANE.props, view: { agentId: 'agent-c' } } })
  expect(await inChild.find({ type: 'Text', text: /▶/ })).toBeDefined()
  await inChild.press({ key: 'view-up-agent-p' })
  await inChild.press({ key: 'view-agent-c' }) // its own card again: back to the agent that spawned it
  await inChild.press({ key: 'view-main' })
  expect(views).toEqual(['agent-c', 'agent-p', 'agent-p', undefined])
  await inChild.unmount()
})

test("a child agent's card sits right under its parent's, a level in", async () => {
  const base = { description: 'd', type: 'Explore', status: 'running' as const, steps: 0, tools: 0, output: 0 }
  const tree = agentTree([
    { ...base, id: 'p', startedAt: 1 },
    { ...base, id: 'c', startedAt: 3, parentId: 'p' },
    { ...base, id: 'q', startedAt: 2 },
    // Its parent has left the panel: it stands at the top level.
    { ...base, id: 'o', startedAt: 0, parentId: 'gone' },
  ])
  expect(tree.map(r => `${r.a.id}${r.depth}`)).toEqual(['q0', 'p0', 'c1', 'o0'])
})
