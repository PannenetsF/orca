import { describe, expect, it } from 'vitest'
import { parseCustomGitServerRemote } from './repository-ref'

describe('parseCustomGitServerRemote', () => {
  it('parses an https remote', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('parses an scp-like ssh remote', () => {
    expect(parseCustomGitServerRemote('git@git.example.com:team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('keeps nested groups in the owner path', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/group/sub/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'group/sub',
      repo: 'orca'
    })
  })

  it('keeps the http(s) port in the host', () => {
    expect(parseCustomGitServerRemote('https://git.example.com:8443/team/orca')).toEqual({
      host: 'git.example.com:8443',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('drops the ssh transport port from the host', () => {
    expect(parseCustomGitServerRemote('ssh://git@git.example.com:2222/team/orca.git')).toEqual({
      host: 'git.example.com',
      owner: 'team',
      repo: 'orca'
    })
  })

  it('returns null for a path without owner/repo', () => {
    expect(parseCustomGitServerRemote('https://git.example.com/orca')).toBeNull()
  })

  it('returns null for an unsupported protocol', () => {
    expect(parseCustomGitServerRemote('ftp://git.example.com/team/orca')).toBeNull()
  })
})
