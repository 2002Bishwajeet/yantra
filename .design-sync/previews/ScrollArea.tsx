import { ScrollArea } from 'yantra-web';

const log = [
  ['12:00:01', 'macbook', 'yantra', 'agent running'],
  ['12:00:01', 'macbook', 'site', 'awaiting trust'],
  ['12:00:03', 'cachyos-g14', 'api', 'agent crashed (exit 137)'],
  ['12:00:03', 'cachyos-g14', 'notes', 'idle'],
  ['12:00:09', 'pi', 'infra', 'unreachable: No route to host'],
  ['12:00:19', 'macbook', 'yantra', 'transcript 4.2 kB'],
  ['12:00:31', 'macbook', 'site', 'still awaiting trust'],
  ['12:00:40', 'cachyos-g14', 'api', 'Re-check requested'],
  ['12:00:41', 'cachyos-g14', 'api', 'session name still held by tmux'],
  ['12:01:02', 'pi', 'infra', 'Re-check requested'],
  ['12:01:05', 'pi', 'infra', 'unreachable: No route to host'],
  ['12:01:12', 'macbook', 'yantra', 'agent running'],
  ['12:01:30', 'cachyos-g14', 'notes', 'Start claude'],
  ['12:01:33', 'cachyos-g14', 'notes', 'agent running'],
];

export const SessionLog = () => (
  <div style={{ height: '12rem', width: '30rem', border: '1px solid var(--border)', borderRadius: '0.5rem' }}>
    <ScrollArea>
      <ul style={{ listStyle: 'none', margin: 0, padding: '0.5rem 0', fontSize: '0.8125rem', fontVariantNumeric: 'tabular-nums' }}>
        {log.map(([at, machine, ws, what], i) => (
          <li key={i} style={{ display: 'grid', gridTemplateColumns: '4.5rem 6.5rem 4rem 1fr', gap: '0.75rem', padding: '0.25rem 0.75rem' }}>
            <span style={{ color: 'var(--muted-foreground)' }}>{at}</span>
            <span>{machine}</span>
            <span style={{ fontWeight: 500 }}>{ws}</span>
            <span>{what}</span>
          </li>
        ))}
      </ul>
    </ScrollArea>
  </div>
);

export const WithFade = () => (
  <div style={{ height: '10rem', width: '20rem' }}>
    <ScrollArea scrollFade>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, fontSize: '0.875rem' }}>
        {['yantra', 'site', 'api', 'infra', 'notes', 'landing', 'blog', 'dotfiles', 'homelab', 'scratch'].map((ws) => (
          <li key={ws} style={{ padding: '0.375rem 0.75rem', borderBottom: '1px solid var(--border)' }}>
            /w/{ws}
          </li>
        ))}
      </ul>
    </ScrollArea>
  </div>
);
