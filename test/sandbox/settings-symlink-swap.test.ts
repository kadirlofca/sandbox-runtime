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

  it('refuses a leaf symlink in a writable directory', () => {
    const target = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(target, '{}')
    const link = path.join(realTmpDir, 'settings.json')
    fs.symlinkSync(target, link)
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

  it('refuses a chain: non-writable dir link -> writable dir link -> target', () => {
    if (isRoot) return // root can write anywhere

    const protectedDir = path.join(realTmpDir, 'protected')
    fs.mkdirSync(protectedDir)
    const writableDir = path.join(realTmpDir, 'writable')
    fs.mkdirSync(writableDir)
    const realFile = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(realFile, '{}')

    // finalLink is in writableDir — swappable
    const finalLink = path.join(writableDir, 'settings.json')
    fs.symlinkSync(realFile, finalLink)

    // hop is in protectedDir (non-writable) — points to finalLink
    const hop = path.join(protectedDir, 'hop')
    fs.symlinkSync(finalLink, hop)

    // Lock protectedDir AFTER creating the symlink
    fs.chmodSync(protectedDir, 0o555)

    try {
      const result = findSwappableSymlink(hop)
      expect(result).not.toBeUndefined()
      expect(result!.link).toBe(finalLink)
      expect(result!.dir).toBe(writableDir)
    } finally {
      fs.chmodSync(protectedDir, 0o755)
    }
  })

  it('allows a symlink inside a non-writable (0555) directory', () => {
    if (isRoot) return // root bypasses permission checks

    const protectedDir = path.join(realTmpDir, 'protected')
    fs.mkdirSync(protectedDir)
    const realFile = path.join(realTmpDir, 'real.json')
    fs.writeFileSync(realFile, '{}')

    // Create symlink BEFORE making the directory non-writable
    const link = path.join(protectedDir, 'settings.json')
    fs.symlinkSync(realFile, link)
    fs.chmodSync(protectedDir, 0o555)

    try {
      const result = findSwappableSymlink(link)
      expect(result).toBeUndefined()
    } finally {
      fs.chmodSync(protectedDir, 0o755)
    }
  })

  it('refuses immediately when a symlink loop is in a writable directory', () => {
    // A loop in a writable dir: we refuse at the first link (before looping)
    const a = path.join(realTmpDir, 'a')
    const b = path.join(realTmpDir, 'b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    const result = findSwappableSymlink(a)
    expect(result).not.toBeUndefined()
    expect(result!.link).toBe(a)
  })

  it('throws on a symlink loop inside a non-writable directory', () => {
    if (isRoot) return // root bypasses permission checks

    const protectedDir = path.join(realTmpDir, 'protected')
    fs.mkdirSync(protectedDir)

    // Create loop before locking dir
    const a = path.join(protectedDir, 'a')
    const b = path.join(protectedDir, 'b')
    fs.symlinkSync(b, a)
    fs.symlinkSync(a, b)
    fs.chmodSync(protectedDir, 0o555)

    try {
      expect(() => findSwappableSymlink(a)).toThrow()
    } finally {
      fs.chmodSync(protectedDir, 0o755)
    }
  })
})
