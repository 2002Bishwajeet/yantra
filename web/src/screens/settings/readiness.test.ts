import { describe, expect, it } from 'vitest'
import { onMachines } from './readiness'

describe('onMachines', () => {
  it('says the sweep is still being read when there is no count', () => {
    expect(onMachines(null, 'present')).toBe('present on the machines is still being read')
  })

  it('says no machine is checked when the sweep reported none, capitalised after a capital verb', () => {
    expect(onMachines({ present: 0, of: 0 }, 'present')).toBe('no machine is checked yet')
    expect(onMachines({ present: 0, of: 0 }, 'Signed in')).toBe('No machine is checked yet')
  })

  it('keeps N of M once a machine is checked', () => {
    expect(onMachines({ present: 0, of: 3 }, 'present')).toBe('present on 0 of 3 machines')
    expect(onMachines({ present: 2, of: 3 }, 'Signed in')).toBe('Signed in on 2 of 3 machines')
  })
})
