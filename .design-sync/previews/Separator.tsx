import { Separator } from 'yantra-web';

export const Horizontal = () => (
  <div style={{ maxWidth: '24rem', fontSize: '0.875rem' }}>
    <div style={{ fontWeight: 500 }}>yantra</div>
    <div style={{ color: 'var(--color-muted-foreground)' }}>~/code/yantra on macbook</div>
    <Separator style={{ marginTop: '0.75rem', marginBottom: '0.75rem' }} />
    <div>Running for 12 s. Two sessions attached.</div>
  </div>
);

export const Vertical = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', height: '1.25rem', fontSize: '0.875rem' }}>
    <span>macbook</span>
    <Separator orientation="vertical" />
    <span>cachyos-g14</span>
    <Separator orientation="vertical" />
    <span>pi</span>
  </div>
);

export const InList = () => (
  <div style={{ display: 'flex', flexDirection: 'column', maxWidth: '20rem', fontSize: '0.875rem' }}>
    <div style={{ padding: '0.5rem 0' }}>Start claude</div>
    <Separator />
    <div style={{ padding: '0.5rem 0' }}>Resume</div>
    <Separator />
    <div style={{ padding: '0.5rem 0' }}>Attach</div>
    <Separator />
    <div style={{ padding: '0.5rem 0', color: 'var(--color-destructive)' }}>Kill session</div>
  </div>
);
