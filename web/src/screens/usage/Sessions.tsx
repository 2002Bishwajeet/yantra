import { createColumnHelper, tableFeatures, useTable } from '@tanstack/react-table'
import type { FormFactor } from '@/shell/formFactor'
import { count, money } from './format'
import type { Line } from './read'

const features = tableFeatures({})
const helper = createColumnHelper<typeof features, Line>()

const cost = helper.accessor('cost', {
  header: 'Cost',
  cell: (info) => {
    const value = info.getValue()
    return value === null ? 'unpriced' : money(value)
  },
})

const columns = {
  workspace: helper.accessor('workspace', { header: 'Workspace' }),
  session: helper.accessor('session', { header: 'Session' }),
  machine: helper.accessor('machine', { header: 'Machine' }),
  models: helper.accessor('models', { header: 'Models' }),
  input: helper.accessor('input', { header: 'Input', cell: (info) => count(info.getValue()) }),
  output: helper.accessor('output', { header: 'Output', cell: (info) => count(info.getValue()) }),
  cacheRead: helper.accessor('cacheRead', {
    header: 'Cache reads',
    cell: (info) => count(info.getValue()),
  }),
  cost,
}

// The tablet and phone boards drop columns rather than shrink the type.
const SETS = {
  desktop: helper.columns([
    columns.workspace,
    columns.session,
    columns.machine,
    columns.models,
    columns.input,
    columns.output,
    columns.cacheRead,
    columns.cost,
  ]),
  tablet: helper.columns([columns.workspace, columns.models, columns.output, columns.cost]),
  phone: helper.columns([columns.workspace, columns.models, columns.cost]),
}

const NUMERIC = new Set(['input', 'output', 'cacheRead', 'cost'])

/** The sessions table, on TanStack Table so the Usage route is the only chunk
 *  that carries it (ADR-0024 §3). */
export function SessionsTable(props: { data: Line[]; factor: FormFactor }) {
  const { data, factor } = props
  const table = useTable({ features, columns: SETS[factor], data })

  return (
    // Focusable so a keyboard can scroll it, which is what axe asks of any
    // region that scrolls (`scrollable-region-focusable`).
    <div aria-label="Sessions table" className="usage__scroll" role="group" tabIndex={0}>
      <table className="usage__table">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header) => (
                <th data-numeric={NUMERIC.has(header.column.id) ? '' : undefined} key={header.id} scope="col">
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id}>
              {row.getAllCells().map((cell) => (
                <td data-numeric={NUMERIC.has(cell.column.id) ? '' : undefined} key={cell.id}>
                  <table.FlexRender cell={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
