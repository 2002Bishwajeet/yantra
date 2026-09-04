import { Input } from 'yantra-web';

export const Default = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '20rem' }}>
    <Input placeholder="Workspace name" />
    <Input defaultValue="~/code/yantra" />
    <Input type="search" placeholder="Search sessions on macbook" />
  </div>
);

export const Sizes = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '20rem' }}>
    <Input size="sm" defaultValue="pi" />
    <Input size="default" defaultValue="macbook" />
    <Input size="lg" defaultValue="cachyos-g14" />
  </div>
);

export const States = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '20rem' }}>
    <Input defaultValue="~/code/yantr" aria-invalid />
    <Input defaultValue="pi is unreachable" disabled />
    <Input defaultValue="infra" readOnly />
  </div>
);
