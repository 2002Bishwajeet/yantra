import { Button } from 'yantra-web';

export const Verbs = () => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
    <Button>Start claude</Button>
    <Button variant="secondary">Resume</Button>
    <Button variant="outline">Attach</Button>
    <Button variant="ghost">Transcript</Button>
    <Button variant="link">/w/yantra</Button>
    <Button variant="destructive">Stop</Button>
    <Button variant="destructive-outline">Kill session</Button>
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
    <Button size="xs">Re-check</Button>
    <Button size="sm">Re-check</Button>
    <Button size="default">Re-check</Button>
    <Button size="lg">Re-check</Button>
    <Button size="xl">Re-check</Button>
  </div>
);

export const Disabled = () => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
    <Button disabled>Start claude</Button>
    <Button variant="outline" disabled>Attach</Button>
    <Button variant="destructive" disabled>Stop</Button>
  </div>
);
