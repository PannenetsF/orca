import type {
  CustomGitServer,
  CustomGitServerDraft,
  CustomGitServerStatus,
  CustomGitServerTestResult
} from '../../shared/custom-git-server'
import {
  computeCustomGitServerId,
  getCustomGitServerById,
  getCustomGitServerForHost,
  listCustomGitServers,
  normalizeCustomGitServerDraft,
  writeCustomGitServerConfig,
  _resetCustomGitServerStoreCache
} from './server-config-store'
import {
  deleteCustomGitServerToken,
  getCustomGitServerToken,
  hasStoredCustomGitServerToken,
  saveCustomGitServerToken,
  _resetCustomGitServerTokenCache
} from './token-store'
import { getCustomGitServerFlavorClient } from './api-flavor'

// Facade over the electron-free config store and the electron-backed token
// store. IPC + preflight consume this; forge-provider detection deliberately
// depends only on the config store (host match) to stay electron-free.
export {
  getCustomGitServerById,
  getCustomGitServerForHost,
  getCustomGitServerToken,
  listCustomGitServers
}

/** @internal - exposed for tests only */
export function _resetCustomGitServerStore(): void {
  _resetCustomGitServerStoreCache()
  _resetCustomGitServerTokenCache()
}

/**
 * Create or update a server. When `id` is provided the record is updated in
 * place (identity preserved); otherwise a deterministic id from host+apiBaseUrl
 * is used (idempotent upsert). A non-empty `token` is saved; omitting it keeps
 * any existing token.
 */
export function saveCustomGitServer(
  draft: CustomGitServerDraft & { id?: string }
): CustomGitServer {
  const normalized = normalizeCustomGitServerDraft(draft)
  const id = draft.id ?? computeCustomGitServerId(normalized.host, normalized.apiBaseUrl)
  const server: CustomGitServer = { id, ...normalized }

  if (draft.token && draft.token.trim()) {
    saveCustomGitServerToken(id, draft.token.trim())
  }

  const servers = listCustomGitServers().filter((existing) => existing.id !== id)
  writeCustomGitServerConfig([...servers, server])
  return server
}

export function removeCustomGitServer(id: string): void {
  deleteCustomGitServerToken(id)
  writeCustomGitServerConfig(listCustomGitServers().filter((server) => server.id !== id))
}

async function verifyServer(
  server: CustomGitServer,
  token: string
): Promise<CustomGitServerTestResult> {
  try {
    const result = await getCustomGitServerFlavorClient(server.apiFlavor).verify(server, token)
    return result
      ? { ok: true, account: result.account }
      : { ok: false, error: 'The server rejected the token or could not be reached.' }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Verify a token against a server definition without persisting anything. */
export async function testCustomGitServerConnection(
  draft: CustomGitServerDraft & { token: string }
): Promise<CustomGitServerTestResult> {
  const normalized = normalizeCustomGitServerDraft(draft)
  if (!normalized.host || !normalized.apiBaseUrl) {
    return { ok: false, error: 'Host and API base URL are required.' }
  }
  const token = draft.token.trim()
  if (!token) {
    return { ok: false, error: 'A token is required to test the connection.' }
  }
  return verifyServer({ id: 'test', ...normalized }, token)
}

async function statusForServer(server: CustomGitServer): Promise<CustomGitServerStatus> {
  const base: Omit<CustomGitServerStatus, 'authenticated' | 'account'> = {
    id: server.id,
    name: server.name,
    host: server.host,
    apiBaseUrl: server.apiBaseUrl,
    apiFlavor: server.apiFlavor,
    configured: hasStoredCustomGitServerToken(server.id)
  }
  if (!base.configured) {
    return { ...base, authenticated: false, account: null }
  }
  let token: string | null
  try {
    token = getCustomGitServerToken(server.id)
  } catch {
    // Undecryptable token: configured but not usable.
    return { ...base, authenticated: false, account: null }
  }
  if (!token) {
    return { ...base, authenticated: false, account: null }
  }
  const result = await verifyServer(server, token)
  return { ...base, authenticated: result.ok, account: result.ok ? result.account : null }
}

/** Status of every configured server (token presence + live auth check). */
export function getCustomGitServerStatuses(): Promise<CustomGitServerStatus[]> {
  return Promise.all(listCustomGitServers().map((server) => statusForServer(server)))
}
