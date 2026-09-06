import { Button, Spinner } from 'yantra-web';

export const Sizes = () => (
  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
    <Spinner size={16} />
    <Spinner size={20} />
    <Spinner size={24} />
    <Spinner size={32} />
  </div>
);

export const WithText = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.875rem' }}>
    <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
      <Spinner size={16} /> Reaching macbook over ssh
    </span>
    <span style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: 'var(--color-muted-foreground)' }}>
      <Spinner size={16} /> Starting claude in yantra
    </span>
  </div>
);

export const InButton = () => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
    <Button disabled>
      <Spinner size={16} /> Starting
    </Button>
    <Button variant="outline" disabled>
      <Spinner size={16} /> Re-checking pi
    </Button>
  </div>
);
