import { describe, expect, it } from 'vitest'
import { parseHostAndOptionalPort, parseSshHostInput } from './ssh-host-input'

describe('parseSshHostInput', () => {
  it('parses scp-style user, host, and port input', () => {
    expect(parseSshHostInput('deploy@example.com:2202')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: 2202,
      configHost: 'example.com'
    })
  })

  it('parses ssh URLs', () => {
    expect(parseSshHostInput('ssh://deploy@example.com:2202/srv/app')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: 2202,
      configHost: 'example.com'
    })
  })

  it('normalizes bracketed IPv6 hosts from ssh URLs', () => {
    expect(parseSshHostInput('ssh://deploy@[::1]:2202/srv/app')).toEqual({
      host: '::1',
      username: 'deploy',
      port: 2202,
      configHost: '::1'
    })
  })

  it('marks invalid pasted host ports instead of keeping them in the hostname', () => {
    expect(parseSshHostInput('deploy@example.com:99999')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: undefined,
      invalidPort: true,
      configHost: 'example.com'
    })
    expect(parseSshHostInput('[::1]:0')).toEqual({
      host: '::1',
      username: undefined,
      port: undefined,
      invalidPort: true,
      configHost: '::1'
    })
  })

  it('marks invalid ssh URL ports instead of keeping the raw URL as the hostname', () => {
    expect(parseSshHostInput('ssh://deploy@example.com:99999/srv/app')).toEqual({
      host: 'example.com',
      username: 'deploy',
      port: undefined,
      invalidPort: true,
      configHost: 'example.com'
    })
  })

  it('does not throw on malformed username escapes in invalid ssh URL ports', () => {
    expect(parseSshHostInput('ssh://bad%ZZ@example.com:99999/srv/app')).toEqual({
      host: 'example.com',
      username: 'bad%ZZ',
      port: undefined,
      invalidPort: true,
      configHost: 'example.com'
    })
  })

  it('keeps plain OpenSSH config aliases valid without a username', () => {
    expect(parseSshHostInput('prod-box')).toEqual({
      host: 'prod-box',
      username: undefined,
      port: undefined,
      configHost: 'prod-box'
    })
  })
})

describe('parseHostAndOptionalPort', () => {
  it('splits one colon into host and port, and leaves a bare IPv6 address whole', () => {
    expect(parseHostAndOptionalPort('example.com:2202')).toEqual({
      host: 'example.com',
      port: 2202
    })
    expect(parseHostAndOptionalPort('fe80::1')).toEqual({ host: 'fe80::1' })
  })
})
