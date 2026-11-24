import { spawnSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'

/**
 * Find the path to an executable, similar to the `which` command.
 * Uses Bun.which when running in Bun, falls back to spawnSync for Node.js.
 *
 * @param bin - The name of the executable to find
 * @returns The full path to the executable, or null if not found
 */
export function whichSync(bin: string): string | null {
  // Check if we're running in Bun
  if (typeof globalThis.Bun !== 'undefined') {
    return globalThis.Bun.which(bin)
  }

  // Fallback to Node.js implementation
  const result = spawnSync('/usr/bin/which', [bin], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 1000,
  })

  if (result.status === 0 && result.stdout) {
    return result.stdout.trim()
  }

  return null
}

const SYSTEM_BIN_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']

/**
 * Resolve a helper binary that srt itself runs OUTSIDE the sandbox. Fixed
 * system directories are searched before PATH: with permissive write defaults
 * a sandboxed command can plant a same-named file in a user-writable PATH
 * directory, and srt would run it unsandboxed on the next invocation.
 */
export function resolveSystemBinary(bin: string): string {
  for (const dir of SYSTEM_BIN_DIRS) {
    const candidate = `${dir}/${bin}`
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // not here
    }
  }
  return whichSync(bin) ?? bin
}
