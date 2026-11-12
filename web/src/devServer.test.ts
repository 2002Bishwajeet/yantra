// @vitest-environment node
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from 'vite'

const web = resolve(__dirname, '..')

describe('Y-788 the dev server binds loopback', () => {
  it('listens on 127.0.0.1 when no --host is given', async () => {
    const server = await createServer({
      configFile: resolve(web, 'vite.config.ts'),
      root: web,
      logLevel: 'silent',
      optimizeDeps: { noDiscovery: true },
      server: { port: 0, watch: null, hmr: false },
    })
    try {
      await server.listen()
      expect(server.httpServer?.address()).toMatchObject({ address: '127.0.0.1' })
    } finally {
      await server.close()
    }
  })

  it('only dev:tailnet asks for the tailnet', () => {
    const { scripts } = JSON.parse(readFileSync(resolve(web, 'package.json'), 'utf8'))
    expect(scripts.dev).not.toContain('--host')
    expect(scripts['dev:fixture']).not.toContain('--host')
    expect(scripts['dev:tailnet']).toContain('--host $(tailscale ip -4)')
  })
})
