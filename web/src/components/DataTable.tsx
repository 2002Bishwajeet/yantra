import { Fragment, type ReactNode, useSyncExternalStore } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Empty, EmptyHeader, EmptyTitle } from '@/components/ui/empty'

export type Column<T> = {
  header: string
  cell: (row: T) => ReactNode
}

/** Y-121: a table cannot be made to fit here, and no column order saves it. The
 *  cells do not wrap, and a workspace name beside a MagicDNS one measures 311 px
 *  before the buttons start — more than the 310 px a 390 px phone shows. */
const PHONE = '(width < 48rem)'

function watch(onChange: () => void) {
  const query = window.matchMedia(PHONE)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function onPhone() {
  return window.matchMedia(PHONE).matches
}

/** `empty` is required because "we looked and there is nothing" is a real
 *  answer, and it is not the same answer as never having looked. */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
}: {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string
  empty: string
}) {
  const phone = useSyncExternalStore(watch, onPhone)

  if (rows.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{empty}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    )
  }

  // Every column kept and labelled: dropping one below a breakpoint is a fact
  // the page stops saying, and the ones a cut must keep overflow on their own.
  if (phone) {
    return (
      <div className="divide-border flex flex-col divide-y">
        {rows.map((row) => (
          <dl
            key={rowKey(row)}
            className="grid grid-cols-[minmax(0,5.5rem)_minmax(0,1fr)] gap-x-3 gap-y-2 py-3 text-sm first:pt-0 last:pb-0"
          >
            {columns.map((column) => (
              <Fragment key={column.header}>
                <dt className="text-muted-foreground text-xs">
                  {column.header}
                </dt>
                <dd className="min-w-0 break-words">{column.cell(row)}</dd>
              </Fragment>
            ))}
          </dl>
        ))}
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((column) => (
            <TableHead key={column.header}>{column.header}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={rowKey(row)}>
            {columns.map((column) => (
              <TableCell key={column.header}>{column.cell(row)}</TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
