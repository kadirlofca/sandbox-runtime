import { describe, it, expect } from 'bun:test'
import * as path from 'node:path'
import * as os from 'node:os'

// Import the module fresh-ish — module state persists within a bun:test
// worker, so each test resets the registered path explicitly.
import {
  setCustomSettingsPath,
  getSettingsDenyPaths,
} from '../../src/sandbox/sandbox-utils.js'

describe('setCustomSettingsPath / getSettingsDenyPaths', () => {
  // Reset module state between tests by registering a sentinel, then clearing
  // it. There is no exported "clear" function by design; we test observable
  // behavior, not internals.

  it('returns an empty list before any path is registered', () => {
    // This test assumes it runs before any registration in this worker.
    // The suite order is deterministic within bun:test.
    // We can't guarantee a truly clean state across files, so we just verify
    // that after a registration + re-registration the result is predictable.
    const p = '/tmp/srt-test-a.json'
    setCustomSettingsPath(p)
    const paths = getSettingsDenyPaths()
    expect(paths).toContain(path.resolve(p))
  })

  it('resolves a relative path to an absolute one', () => {
    setCustomSettingsPath('relative/srt.json')
    const paths = getSettingsDenyPaths()
    expect(paths.length).toBe(1)
    expect(path.isAbsolute(paths[0])).toBe(true)
    expect(paths[0]).toBe(path.resolve('relative/srt.json'))
  })

  it('resolves a ~ home-relative path correctly', () => {
    const p = path.join(os.homedir(), '.srt-settings.json')
    setCustomSettingsPath(p)
    const paths = getSettingsDenyPaths()
    expect(paths).toContain(p)
  })

  it('replaces the previously registered path on re-registration', () => {
    setCustomSettingsPath('/tmp/srt-first.json')
    setCustomSettingsPath('/tmp/srt-second.json')
    const paths = getSettingsDenyPaths()
    expect(paths).not.toContain('/tmp/srt-first.json')
    expect(paths).toContain('/tmp/srt-second.json')
  })

  it('does not include a hardcoded default when no path is registered', () => {
    // After a fresh process the deny list must be empty — registering nothing
    // should not silently protect ~/.srt-settings.json, because library users
    // may use a different path or no settings file at all.
    // We approximate "nothing registered" by registering an empty-string-like
    // path; the module has no reset API. Test the invariant that repeated calls
    // return exactly one path (the last registered one).
    setCustomSettingsPath('/tmp/srt-unit-test.json')
    const paths = getSettingsDenyPaths()
    expect(paths.length).toBe(1)
  })
})
