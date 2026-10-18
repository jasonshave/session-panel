// Prints when the session's prompt cache was last used and how long it lives, as
// {"lastAt": ms, "ttlMs": ms}, or null. Usage: node cache-expiry.js <sessionId> <configDir>
//
// Every request that reads or writes the cache restarts its clock, so the expiry is the
// last main-thread response plus whichever lifetime the session writes (1 hour or 5
// minutes). Only the transcript's tail is read, so a long session costs no more than a
// short one: the mod itself may read 4 MiB at most, and a transcript grows past that.
const fs = require('fs')
const path = require('path')

const [id, configDir] = process.argv.slice(2)
let out = null
try {
  const projects = path.join(configDir, 'projects')
  const dir = fs.readdirSync(projects).find(d => fs.existsSync(path.join(projects, d, `${id}.jsonl`)))
  const fd = fs.openSync(path.join(projects, dir, `${id}.jsonl`), 'r')
  const len = fs.fstatSync(fd).size
  const n = Math.min(len, 512 * 1024)
  const buf = Buffer.alloc(n)
  fs.readSync(fd, buf, 0, n, len - n)
  fs.closeSync(fd)
  const lines = buf.toString('utf8').split('\n')
  let lastAt = null
  let ttlMs = null
  for (let i = lines.length - 1; i >= 0 && (lastAt == null || ttlMs == null); i--) {
    if (!lines[i].includes('"usage"')) continue
    let j
    try { j = JSON.parse(lines[i]) } catch (_) { continue }
    const u = j.message && j.message.usage
    if (j.type !== 'assistant' || j.isSidechain || !u) continue
    if (lastAt == null && (u.cache_read_input_tokens || u.cache_creation_input_tokens)) {
      lastAt = Date.parse(j.timestamp)
    }
    const cc = u.cache_creation || {}
    if (cc.ephemeral_1h_input_tokens > 0) ttlMs = 60 * 60 * 1000
    else if (cc.ephemeral_5m_input_tokens > 0) ttlMs = 5 * 60 * 1000
  }
  if (lastAt != null) out = { lastAt, ttlMs: ttlMs || 5 * 60 * 1000 }
} catch (_) {
  // No transcript yet.
}
process.stdout.write(JSON.stringify(out) + '\n')
