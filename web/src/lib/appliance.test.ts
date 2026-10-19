import { describe, expect, it } from 'vitest'
import { aMachine } from '@/api/fixtures'
import * as contract from '@/contract.gen'
import { appliance } from './appliance'

const here = aMachine({ name: 'pi', address: '100.64.0.1' })
const other = aMachine({ name: 'mac', address: '100.64.0.2' })

describe('the appliance node', () => {
  it('is the machine whose address the daemon is bound to', () => {
    expect(appliance([other, here], contract.about)?.name).toBe('pi')
  })

  it('reads a bracketed IPv6 entry without its port', () => {
    const v6 = aMachine({ name: 'v6', address: 'fd7a:115c:a1e0::1' })
    const about = { ...contract.about, listening_on: ['[fd7a:115c:a1e0::1]:7717'] }
    expect(appliance([other, v6], about)?.name).toBe('v6')
  })

  it('is null when nothing matches or nothing is known', () => {
    expect(appliance([other], contract.about)).toBeNull()
    expect(appliance([here], undefined)).toBeNull()
    expect(appliance([aMachine({ address: null })], { ...contract.about, listening_on: [] })).toBeNull()
  })
})
