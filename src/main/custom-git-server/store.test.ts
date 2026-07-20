import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'

const { homeHolder, safeStorageMock, verifyMock } = vi.hoisted(() => ({
  homeHolder: { path: '' },
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf-8')),
    decryptString: vi.fn((value: Buffer) => value.toString('utf-8').replace(/^enc:/, ''))
  },
  verifyMock: vi.fn()
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>()
  return { ...actual, homedir: () => homeHolder.path }
})

vi.mock('electron', () => ({ safeStorage: safeStorageMock }))

vi.mock('./api-flavor', () => ({
  getCustomGitServerFlavorClient: () => ({ verify: verifyMock })
}))

import {
  getCustomGitServerById,
  getCustomGitServerForHost,
  getCustomGitServerStatuses,
  getCustomGitServerToken,
  listCustomGitServers,
  removeCustomGitServer,
  saveCustomGitServer,
  testCustomGitServerConnection,
  _resetCustomGitServerStore
} from './store'

const draft = {
  name: 'My Git Server',
  host: 'git.example.com',
  apiBaseUrl: 'https://git.example.com',
  apiFlavor: 'gitlab' as const,
  token: 'secret-token'
}

describe('custom git server store', () => {
  beforeEach(() => {
    homeHolder.path = mkdtempSync(join(tmpdir(), 'orca-cgs-'))
    _resetCustomGitServerStore()
    verifyMock.mockReset()
    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
  })

  afterEach(() => {
    rmSync(homeHolder.path, { recursive: true, force: true })
  })

  it('saves, lists, and resolves a server by host', () => {
    const server = saveCustomGitServer(draft)
    expect(server.host).toBe('git.example.com')
    expect(listCustomGitServers()).toHaveLength(1)
    expect(getCustomGitServerForHost('git@git.example.com:team/repo.git')?.id).toBe(server.id)
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('persists across a cache reset (reads back from disk)', () => {
    const server = saveCustomGitServer(draft)
    _resetCustomGitServerStore()
    expect(listCustomGitServers().map((s) => s.id)).toEqual([server.id])
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
  })

  it('keeps the existing token when updating without one', () => {
    const server = saveCustomGitServer(draft)
    saveCustomGitServer({ id: server.id, ...draft, name: 'Renamed', token: '' })
    expect(getCustomGitServerToken(server.id)).toBe('secret-token')
    expect(getCustomGitServerById(server.id)?.name).toBe('Renamed')
  })

  it('removes a server and its token', () => {
    const server = saveCustomGitServer(draft)
    removeCustomGitServer(server.id)
    expect(listCustomGitServers()).toHaveLength(0)
    expect(getCustomGitServerToken(server.id)).toBeNull()
  })

  it('reports authenticated status when the flavor verify succeeds', async () => {
    verifyMock.mockResolvedValue({ account: 'fanyunqian' })
    saveCustomGitServer(draft)
    const [status] = await getCustomGitServerStatuses()
    expect(status).toMatchObject({
      host: 'git.example.com',
      configured: true,
      authenticated: true,
      account: 'fanyunqian'
    })
  })

  it('reports not-authenticated when verify returns null', async () => {
    verifyMock.mockResolvedValue(null)
    saveCustomGitServer(draft)
    const [status] = await getCustomGitServerStatuses()
    expect(status).toMatchObject({ configured: true, authenticated: false, account: null })
  })

  it('tests a draft connection without persisting', async () => {
    verifyMock.mockResolvedValue({ account: 'me' })
    const result = await testCustomGitServerConnection(draft)
    expect(result).toEqual({ ok: true, account: 'me' })
    expect(listCustomGitServers()).toHaveLength(0)
  })

  it('rejects a draft test with no token', async () => {
    const result = await testCustomGitServerConnection({ ...draft, token: '' })
    expect(result.ok).toBe(false)
  })
})
