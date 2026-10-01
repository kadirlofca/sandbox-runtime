import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { findSwappableSymlink } from '../../src/sandbox/sandbox-utils.js'

// Skip entire suite on Windows — findSwappableSymlink always returns undefined there.
const isWindows = process.platform === 'win32'
const describeUnix = isWindows ? describe.skip : describe

const isRoot = process.getuid?.() === 0

let tmpDir: string
let realTmpDir: string // macOS: /tmp is a symlink to /private/tmp

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'srt-symlink-test-'))
  realTmpDir = fs.realpathSync(tmpDir)
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describeUnix('findSwappableSymlink', () => {
  it('returns undefined for a regular file', () => {
    const p = path.join(realTmpDir, 'settings.json')
    fs.writeFileSync(p, '{}')
    expect(findSwappableSymlink(p)).toBeUndefined()
  })

  it('returns undefined for a missing file with no symlinks on path', () => {
    const p = path.join(realTmpDir, 'missing.json')
    expect(findSwappableSymlink(p)).toBeUndefined()
  })

  it('refuses a leaf symlink (absolute target) in a writable directory', () => {
    const target = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(target, '{}')
    const link = path.join(realTmpDir, 'settings.json')
    fs.symlinkSync(target, link)
    const result = findSwappableSymlink(link)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(link)
    expect(result!.dir).toBe(realTmpDir)
  })

  it('refuses a leaf symlink (relative target) in a writable directory', () => {
    // Verifies that relative targets are resolved correctly — a previous bug
    // caused the walk to go off-path and return undefined (safe) for relative targets.
    const target = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(target, '{}')
    const link = path.join(realTmpDir, 'settings.json')
    fs.symlinkSync('./real.json', link) // relative target
    const result = findSwappableSymlink(link)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(link)
    expect(result!.dir).toBe(realTmpDir)
  })

  it('refuses a dangling symlink in a writable directory', () => {
    const link = path.join(realTmpDir, 'settings.json')
    fs.symlinkSync('/nonexistent/target.json', link)
    const result = findSwappableSymlink(link)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(link)
  })

  it('refuses when a parent directory is a symlink in a writable directory', () => {
    const realDir = fs.mkdtempSync(path.join(realTmpDir, 'real-'))
    const realFile = path.join(realDir, 'settings.json')
    fs.writeFileSync(realFile, '{}')
    const linkedDir = path.join(realTmpDir, 'linked-dir')
    fs.symlinkSync(realDir, linkedDir)
    const p = path.join(linkedDir, 'settings.json')
    const result = findSwappableSymlink(p)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(linkedDir)
    expect(result!.dir).toBe(realTmpDir)
  })

  it('refuses a symlink in a user-owned 0555 directory (user can chmod it)', () => {
    if (isRoot) return // root bypasses permission checks

    // The directory is created by us, so uid matches even after chmod 0555.
    // The user can always run chmod u+w on a directory they own, so the
    // symlink is swappable and must be refused.
    const ownedDir = path.join(realTmpDir, 'owned')
    fs.mkdirSync(ownedDir)
    const realFile = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(realFile, '{}')
    const link = path.join(ownedDir, 'settings.json')
    fs.symlinkSync(realFile, link)
    fs.chmodSync(ownedDir, 0o555)

    try {
      const result = findSwappableSymlink(link)
      expect(result).not.toBeUndefined()
    } finally {
      fs.chmodSync(ownedDir, 0o755)
    }
  })

  it('refuses immediately when a symlink loop is in a writable directory', () => {
    // A loop in a writable dir: refused at the first link before following it.
    const a = path.join(realTmpDir, 'a')
    const b = path.join(realTmpDir, 'b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    const result = findSwappableSymlink(a)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(a)
  })

  it('refuses a symlink loop inside a user-owned 0555 directory', () => {
    if (isRoot) return

    // Even in mode 0555, the user owns the dir — uid check triggers a refusal
    // at the first link rather than entering the loop.
    const ownedDir = path.join(realTmpDir, 'owned')
    fs.mkdirSync(ownedDir)
    const a = path.join(ownedDir, 'a')
    const b = path.join(ownedDir, 'b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    fs.chmodSync(ownedDir, 0o555)

    try {
      const result = findSwappableSymlink(a)
      expect(result).not.toBeUndefined()
    } finally {
      fs.chmodSync(ownedDir, 0o755)
    }
  })
})
