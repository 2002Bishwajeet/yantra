import { Table, TableBody, TableCaption, TableCell, TableFooter, TableHead, TableHeader, TableRow } from 'yantra-web';

const rows = [
  { workspace: 'yantra', machine: 'macbook', status: 'running', age: '12 s' },
  { workspace: 'site', machine: 'macbook', status: 'awaiting trust', age: '40 s' },
  { workspace: 'api', machine: 'cachyos-g14', status: 'crashed', age: '3 min' },
  { workspace: 'infra', machine: 'pi', status: 'unreachable', age: '2 h' },
  { workspace: 'notes', machine: 'cachyos-g14', status: 'no agent', age: '9 s' },
];

export const Workspaces = () => (
  <Table>
    <TableCaption>Five workspaces across three machines, read 9 seconds ago.</TableCaption>
    <TableHeader>
      <TableRow>
        <TableHead>Workspace</TableHead>
        <TableHead>Machine</TableHead>
        <TableHead>Status</TableHead>
        <TableHead style={{ textAlign: 'right' }}>Age</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {rows.map((r) => (
        <TableRow key={r.workspace}>
          <TableCell style={{ fontWeight: 500 }}>{r.workspace}</TableCell>
          <TableCell>{r.machine}</TableCell>
          <TableCell>{r.status}</TableCell>
          <TableCell style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.age}</TableCell>
        </TableRow>
      ))}
    </TableBody>
  </Table>
);

export const Spend = () => (
  <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Model</TableHead>
        <TableHead style={{ textAlign: 'right' }}>Input</TableHead>
        <TableHead style={{ textAlign: 'right' }}>Output</TableHead>
        <TableHead style={{ textAlign: 'right' }}>Cost</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      <TableRow>
        <TableCell>claude-opus-5</TableCell>
        <TableCell style={{ textAlign: 'right' }}>1,204,331</TableCell>
        <TableCell style={{ textAlign: 'right' }}>88,120</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$24.61</TableCell>
      </TableRow>
      <TableRow>
        <TableCell>claude-sonnet-5</TableCell>
        <TableCell style={{ textAlign: 'right' }}>310,006</TableCell>
        <TableCell style={{ textAlign: 'right' }}>21,400</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$2.12</TableCell>
      </TableRow>
    </TableBody>
    <TableFooter>
      <TableRow>
        <TableCell colSpan={3}>Total</TableCell>
        <TableCell style={{ textAlign: 'right' }}>$26.73</TableCell>
      </TableRow>
    </TableFooter>
  </Table>
);
