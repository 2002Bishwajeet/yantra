import { Badge } from 'yantra-web';

export const AgentStates = () => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge>running</Badge>
    <Badge variant="secondary">idle</Badge>
    <Badge variant="outline">awaiting trust</Badge>
    <Badge variant="destructive">crashed</Badge>
    <Badge variant="ghost">no agent</Badge>
    <Badge variant="link">unreachable</Badge>
  </div>
);

export const Machines = () => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge variant="outline">macbook</Badge>
    <Badge variant="outline">cachyos-g14</Badge>
    <Badge variant="outline">pi</Badge>
    <Badge variant="secondary">3 machines</Badge>
  </div>
);

export const WithIcon = () => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge>
      <svg data-icon="inline-start" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <circle cx="12" cy="12" r="6" />
      </svg>
      running on macbook
    </Badge>
    <Badge variant="destructive">
      <svg data-icon="inline-start" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden="true">
        <path d="M18 6 6 18M6 6l12 12" />
      </svg>
      crashed on pi
    </Badge>
  </div>
);
