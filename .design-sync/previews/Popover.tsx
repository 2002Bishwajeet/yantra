import {
  Button,
  Popover,
  PopoverDescription,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from 'yantra-web';

const machines = [
  { name: 'macbook', state: '2 agents running' },
  { name: 'cachyos-g14', state: '1 crashed, 1 idle' },
  { name: 'pi', state: 'unreachable for 2 h' },
];

export const Machines = () => (
  <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '0.5rem' }}>
    <Popover open>
      <PopoverTrigger render={<Button variant="outline" />}>3 machines</PopoverTrigger>
      <PopoverPopup style={{ width: '17rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
            <PopoverTitle>Machines</PopoverTitle>
            <PopoverDescription>Reached over Tailscale, checked 9 s ago.</PopoverDescription>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.875rem' }}>
            {machines.map((m) => (
              <li key={m.name} style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontWeight: 500 }}>{m.name}</span>
                <span style={{ color: 'var(--muted-foreground)' }}>{m.state}</span>
              </li>
            ))}
          </ul>
        </div>
      </PopoverPopup>
    </Popover>
  </div>
);

export const Hint = () => (
  <div style={{ display: 'flex', justifyContent: 'center', paddingTop: '0.5rem' }}>
    <Popover open>
      <PopoverTrigger render={<Button variant="ghost" size="sm" />}>Awaiting trust</PopoverTrigger>
      <PopoverPopup tooltipStyle style={{ maxWidth: '16rem' }}>
        Claude is asking whether it may work in ~/code/site. Attach to the session and answer the
        prompt.
      </PopoverPopup>
    </Popover>
  </div>
);
