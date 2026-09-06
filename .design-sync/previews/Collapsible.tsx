import { Button, Collapsible, CollapsiblePanel, CollapsibleTrigger } from 'yantra-web';

const unreachable = [
  { machine: 'pi', since: '2 h', error: 'No route to host' },
  { machine: 'nas', since: '35 min', error: 'Connection refused' },
  { machine: 'vps', since: '4 min', error: 'Operation timed out' },
];

const Body = () => (
  <ul style={{ listStyle: 'none', margin: 0, padding: '0.5rem 0.75rem 0', display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.875rem' }}>
    {unreachable.map((m) => (
      <li key={m.machine} style={{ display: 'flex', gap: '0.75rem' }}>
        <span style={{ fontWeight: 500, minWidth: '3rem' }}>{m.machine}</span>
        <span style={{ color: 'var(--muted-foreground)' }}>
          {m.error} · {m.since}
        </span>
      </li>
    ))}
  </ul>
);

export const Open = () => (
  <Collapsible defaultOpen style={{ width: '22rem' }}>
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Hide 3 unreachable machines</CollapsibleTrigger>
    <CollapsiblePanel>
      <Body />
    </CollapsiblePanel>
  </Collapsible>
);

export const Closed = () => (
  <Collapsible style={{ width: '22rem' }}>
    <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>Show 3 unreachable machines</CollapsibleTrigger>
    <CollapsiblePanel>
      <Body />
    </CollapsiblePanel>
  </Collapsible>
);
