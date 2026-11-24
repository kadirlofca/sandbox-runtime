import { describe, it, expect, afterEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'
import { isMacOS } from '../helpers/platform.js'

/**
 * A sandboxed process must be able to modify keychain items. Without read
 * access to the security.mac.sandbox.sentinel sysctl the Security framework
 * fails every add/modify with "UNIX[Operation not permitted]" (reads still
 * work), so a login or token refresh performed inside the sandbox is lost.
 */

const account = userInfo().username
const service = `srt-keychain-write-test-${process.pid}`

function security(args: string[]) {
  return spawnSync('security', args, { encoding: 'utf8', timeout: 15000 })
}

function sandboxed(command: string) {
  return spawnSync(
    wrapCommandWithSandboxMacOS({
      command,
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: ['/'], denyWithinAllow: [] },
    }),
    { shell: true, encoding: 'utf8', timeout: 30000 },
  )
}

// CI runners without an unlocked login keychain cannot do this at all; only
// assert the sandbox's behaviour when the unsandboxed baseline works.
const keychainUsable =
  isMacOS &&
  security([
    'add-generic-password',
    '-a',
    account,
    '-s',
    service,
    '-w',
    'probe',
  ]).status === 0
if (keychainUsable) {
  security(['delete-generic-password', '-a', account, '-s', service])
}

afterEach(() => {
  if (isMacOS) {
    security(['delete-generic-password', '-a', account, '-s', service])
  }
})

describe.if(isMacOS)('macOS Seatbelt keychain profile', () => {
  it('allows reading the security.mac.sandbox.sentinel sysctl', () => {
    const wrapped = wrapCommandWithSandboxMacOS({
      command: 'true',
      needsNetworkRestriction: false,
      readConfig: undefined,
      writeConfig: { allowOnly: ['/'], denyWithinAllow: [] },
    })
    expect(wrapped).toContain('security.mac.sandbox.sentinel')
  })
})

describe.if(keychainUsable)('macOS Seatbelt keychain write', () => {
  it('lets a sandboxed process update an existing keychain item', () => {
    expect(
      security([
        'add-generic-password',
        '-a',
        account,
        '-s',
        service,
        '-w',
        'v1',
      ]).status,
    ).toBe(0)

    const result = sandboxed(
      `security add-generic-password -U -a ${account} -s ${service} -w v2`,
    )
    expect(result.stderr).not.toContain('Operation not permitted')
    expect(result.status).toBe(0)

    const read = security([
      'find-generic-password',
      '-a',
      account,
      '-s',
      service,
      '-w',
    ])
    expect(read.stdout.trim()).toBe('v2')
  }, 60000)

  it('lets a sandboxed process create a keychain item', () => {
    const result = sandboxed(
      `security add-generic-password -a ${account} -s ${service} -w created`,
    )
    expect(result.stderr).not.toContain('Operation not permitted')
    expect(result.status).toBe(0)
  }, 60000)
})
