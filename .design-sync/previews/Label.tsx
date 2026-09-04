import { Input, Label, Switch } from 'yantra-web';

export const WithInput = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '20rem' }}>
    <Label htmlFor="label-workspace">Workspace name</Label>
    <Input id="label-workspace" defaultValue="yantra" />
  </div>
);

export const WithSwitch = () => (
  <Label style={{ gap: '0.75rem' }}>
    <Switch defaultChecked />
    Attach the browser to this session
  </Label>
);

export const Stacked = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '20rem' }}>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Label htmlFor="label-machine">Machine</Label>
      <Input id="label-machine" defaultValue="macbook" />
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      <Label htmlFor="label-dir">Directory</Label>
      <Input id="label-dir" defaultValue="~/code/yantra" />
    </div>
  </div>
);
