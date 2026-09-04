import { Label, Switch } from 'yantra-web';

export const States = () => (
  <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
    <Switch />
    <Switch defaultChecked />
    <Switch disabled />
    <Switch defaultChecked disabled />
  </div>
);

export const Settings = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: '22rem' }}>
    <Label style={{ justifyContent: 'space-between' }}>
      Notify on crash
      <Switch defaultChecked />
    </Label>
    <Label style={{ justifyContent: 'space-between' }}>
      Attach the browser on start
      <Switch />
    </Label>
    <Label style={{ justifyContent: 'space-between' }}>
      Keep the session after Kill
      <Switch disabled />
    </Label>
  </div>
);
