import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isMacOS } from '../helpers/platform.js'

/**
 * Permissive defaults must still keep the sandbox from rewriting what runs
 * outside it: shell startup files, launch agents, ssh/git config, srt's own
 * settings, and what a denyRead entry hides. Runs the built CLI with a
 * throwaway HOME so no real dotfile is ever at risk.
 */

const cli = join(import.meta.dir, '..', '..', 'dist', 'cli.js')

function setup(config: object) {
  const root = mkdtempSync(join(tmpdir(), 'srt-escape-'))
  const home = join(root, 'home')
  for (const d of ['.ssh', 'Library/LaunchAgents', 'work', '../secret']) {
    mkdirSync(join(home, d), { recursive: true })
  }
  const settings = join(root, 'settings.json')
  writeFileSync(settings, JSON.stringify(config))
  const run = (command: string, env: NodeJS.ProcessEnv = {}) =>
    spawnSync('node', [cli, '-s', settings, '-c', command], {
      cwd: join(home, 'work'),
      env: { ...process.env, HOME: home, ...env },
      encoding: 'utf8',
      timeout: 30000,
    })
  return { root, home, run }
}

const wrote = (r: { stdout: string }) => r.stdout.includes('WROTE')
const attempt = (p: string) => `echo x >> ${p} && echo WROTE || echo BLOCKED`

describe.if(isMacOS && existsSync(cli))('macOS escape-vector denies', () => {
  const cfg = { filesystem: { denyRead: [], denyWrite: [] } }

  for (const rel of [
    '.zshrc',
    '.ssh/authorized_keys',
    '.ssh/config',
    'Library/LaunchAgents/x.plist',
    '.srt-settings.json',
  ]) {
    it(`blocks creating ~/${rel} under the permissive default`, () => {
      const { home, run } = setup(cfg)
      expect(wrote(run(attempt(join(home, rel))))).toBe(false)
      expect(existsSync(join(home, rel))).toBe(false)
    })
  }

  for (const rel of [
    '.zshrc.zwc',
    '.zshenv.zwc',
    '.zcompdump',
    '.bash_aliases',
    '.zsh_sessions/x',
  ]) {
    it(`blocks creating ~/${rel}`, () => {
      const { home, run } = setup(cfg)
      expect(wrote(run(attempt(join(home, rel))))).toBe(false)
    })
  }

  it('blocks planting a launcher name in a PATH dir ahead of the real one', () => {
    const { root, home, run } = setup(cfg)
    const early = join(home, '.local', 'bin')
    const real = join(root, 'realbin')
    mkdirSync(early, { recursive: true })
    mkdirSync(real)
    symlinkSync(process.execPath, join(real, 'node'))
    const env = { PATH: `${early}:${real}:${process.env.PATH}` }
    expect(wrote(run(attempt(join(early, 'node')), env))).toBe(false)
    expect(wrote(run(attempt(join(early, 'other-tool')), env))).toBe(true)
  })

  it('still allows ordinary writes under home and the cwd', () => {
    const { home, run } = setup(cfg)
    expect(wrote(run(attempt(join(home, '.ok-file'))))).toBe(true)
    expect(wrote(run(attempt(join(home, 'work', 'ok'))))).toBe(true)
  })

  it('does not run a binary planted on PATH by an earlier sandboxed command', () => {
    const { root, run } = setup(cfg)
    const fake = join(root, 'fakebin')
    mkdirSync(fake)
    const marker = join(root, 'escaped')
    writeFileSync(join(fake, 'env'), `#!/bin/sh\necho ESCAPED > ${marker}\n`, {
      mode: 0o755,
    })
    const r = run('echo second-run', { PATH: `${fake}:${process.env.PATH}` })
    expect(r.stdout).toContain('second-run')
    expect(existsSync(marker)).toBe(false)
  })
})

describe.if(isMacOS && existsSync(cli))(
  'macOS denyRead is not writable',
  () => {
    it('blocks writes into a denyRead directory when allowWrite is omitted', () => {
      const secret = join(mkdtempSync(join(tmpdir(), 'srt-secret-')), 'dir')
      mkdirSync(secret)
      const { run } = setup({
        filesystem: { denyRead: [secret], denyWrite: [] },
      })
      const r = run(attempt(join(secret, 'planted')))
      expect(wrote(r)).toBe(false)
      expect(existsSync(join(secret, 'planted'))).toBe(false)
    })
  },
)

describe.if(isMacOS && existsSync(cli))(
  'macOS denyRead glob is not writable',
  () => {
    it('blocks overwriting or creating files a denyRead glob matches', () => {
      const dir = mkdtempSync(join(tmpdir(), 'srt-keys-'))
      writeFileSync(join(dir, 'id_a'), 'secret')
      const { run } = setup({
        filesystem: { denyRead: [join(dir, 'id_*')], denyWrite: [] },
      })
      expect(wrote(run(attempt(join(dir, 'id_a'))))).toBe(false)
      expect(wrote(run(attempt(join(dir, 'id_new'))))).toBe(false)
      expect(wrote(run(attempt(join(dir, 'other'))))).toBe(true)
    })
  },
)

describe.if(isMacOS && existsSync(cli))(
  'macOS git-metadata (protectGit), hooksPath and socket escape vectors',
  () => {
    const cfg = {
      filesystem: { denyRead: [], denyWrite: [], protectGit: true },
    }

    it('blocks submodule and worktree git config and hooks', () => {
      const { home, run } = setup(cfg)
      const git = join(home, 'work', '.git')
      mkdirSync(join(git, 'modules', 'm'), { recursive: true })
      for (const rel of [
        'modules/m/config',
        'modules/new/config',
        'modules/m/hooks/post-checkout',
        'worktrees/w/config.worktree',
      ]) {
        expect(wrote(run(attempt(join(git, rel))))).toBe(false)
      }
    })

    it('blocks the directory core.hooksPath points at', () => {
      const { home, run } = setup(cfg)
      const work = join(home, 'work')
      mkdirSync(join(work, '.git'), { recursive: true })
      mkdirSync(join(work, '.husky', '_'), { recursive: true })
      writeFileSync(
        join(work, '.git', 'config'),
        '[core]\n\thooksPath = .husky/_\n',
      )
      expect(wrote(run(attempt(join(work, '.husky/_/pre-commit'))))).toBe(false)
      expect(wrote(run(attempt(join(work, 'ok'))))).toBe(true)
    })

    it('blocks fish autoload directories', () => {
      const { home, run } = setup(cfg)
      mkdirSync(join(home, '.config', 'fish'), { recursive: true })
      for (const rel of ['conf.d/evil.fish', 'functions/ls.fish']) {
        expect(wrote(run(attempt(join(home, '.config/fish', rel))))).toBe(false)
      }
    })

    it('stops a container socket being reached by renaming its directory', () => {
      const { home, run } = setup(cfg)
      mkdirSync(join(home, '.docker', 'run'), { recursive: true })
      writeFileSync(join(home, '.docker', 'run', 'docker.sock'), '')
      const r = run(
        `mv ${join(home, '.docker/run')} ${join(home, 'r2')} && echo WROTE || echo BLOCKED`,
      )
      expect(wrote(r)).toBe(false)
    })
  },
)

describe.if(isMacOS && existsSync(cli))(
  'macOS permissive-default fixes',
  () => {
    it('creates the TMPDIR it points the child at', () => {
      const { run } = setup({ filesystem: { denyRead: [], denyWrite: [] } })
      expect(run('ls -d $TMPDIR && echo EXISTS').stdout).toContain('EXISTS')
    })

    it('allows binding localhost when only deniedDomains is configured', () => {
      const { run } = setup({
        filesystem: { denyRead: [], denyWrite: [] },
        network: { deniedDomains: ['blocked.invalid'] },
      })
      const r = run(
        `node -e "require('net').createServer().listen(0,'127.0.0.1',()=>{console.log('BOUND');process.exit()})"`,
      )
      expect(r.stdout).toContain('BOUND')
    })
  },
)

describe.if(isMacOS && existsSync(cli))('macOS git works by default', () => {
  const cfg = { filesystem: { denyRead: [], denyWrite: [] } }
  const git = 'git -c user.email=a@b -c user.name=n'

  it('allows init, commit, config and hooks with protectGit unset', () => {
    const { home, run } = setup(cfg)
    expect(run('git init -q . && echo OK').stdout).toContain('OK')
    expect(
      run(`echo hi > f && git add f && ${git} commit -q -m c && echo OK`)
        .stdout,
    ).toContain('OK')
    expect(run('git config core.pager cat && echo OK').stdout).toContain('OK')
    expect(
      wrote(run(attempt(join(home, 'work', '.git/hooks/pre-commit')))),
    ).toBe(true)
    expect(run('git config --global user.name t && echo OK').stdout).toContain(
      'OK',
    )
  })

  it('blocks all of that again with protectGit: true', () => {
    const { run } = setup({
      filesystem: { denyRead: [], denyWrite: [], protectGit: true },
    })
    expect(run('git init -q . && echo OK').stdout).not.toContain('OK')
    expect(
      run('git config --global user.name t && echo OK').stdout,
    ).not.toContain('OK')
  })
})

describe.if(isMacOS && existsSync(cli))(
  'macOS network deny list without an allow list',
  () => {
    const fs0 = { denyRead: [], denyWrite: [] }
    const status = (host: string) =>
      `curl -s -o /dev/null -w "%{http_code}" http://${host}/ || true`

    it('refuses a denied host and does not refuse an unnamed one', () => {
      const { run } = setup({
        filesystem: fs0,
        network: { deniedDomains: ['blocked.invalid'] },
      })
      expect(run(status('blocked.invalid')).stdout.trim()).toBe('403')
      expect(run(status('other.invalid')).stdout.trim()).not.toBe('403')
    })

    it('does not reopen loopback when a deny entry names it', () => {
      const probe = `node -e "require('net').connect(47199,'127.0.0.1').on('connect',()=>{console.log('REACHED');process.exit()}).on('error',e=>{console.log('BLOCKED');process.exit()})"`
      const { run } = setup({
        filesystem: fs0,
        network: { deniedDomains: ['127.0.0.1:47199'] },
      })
      expect(run(probe).stdout).not.toContain('REACHED')
    })
  },
)

describe.if(isMacOS && existsSync(cli))(
  'macOS protectGit from a subdirectory',
  () => {
    it('protects the enclosing repo hooks and config', () => {
      const { home } = setup({
        filesystem: { denyRead: [], denyWrite: [], protectGit: true },
      })
      const repo = join(home, 'work', 'repo')
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
      mkdirSync(join(repo, 'sub'))
      const inSub = (c: string) =>
        spawnSync(
          'node',
          [cli, '-s', join(home, '..', 'settings.json'), '-c', c],
          {
            cwd: join(repo, 'sub'),
            env: { ...process.env, HOME: home },
            encoding: 'utf8',
            timeout: 30000,
          },
        )
      expect(wrote(inSub(attempt(join(repo, '.git/hooks/pre-commit'))))).toBe(
        false,
      )
      expect(wrote(inSub(attempt(join(repo, '.git/config'))))).toBe(false)
      expect(wrote(inSub(attempt(join(repo, 'sub/ok'))))).toBe(true)
    })
  },
)
