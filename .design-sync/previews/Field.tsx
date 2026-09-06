import { Field, FieldDescription, FieldError, FieldItem, FieldLabel, Input, Switch } from 'yantra-web';

export const Default = () => (
  <Field style={{ maxWidth: '20rem' }}>
    <FieldLabel>Workspace name</FieldLabel>
    <Input defaultValue="yantra" />
    <FieldDescription>Follows the directory name until you edit it.</FieldDescription>
  </Field>
);

export const Invalid = () => (
  <Field invalid style={{ maxWidth: '20rem' }}>
    <FieldLabel>Directory</FieldLabel>
    <Input defaultValue="~/code/yantr" aria-invalid />
    <FieldError match>No such directory on macbook.</FieldError>
  </Field>
);

export const Disabled = () => (
  <Field disabled style={{ maxWidth: '20rem' }}>
    <FieldLabel>Machine</FieldLabel>
    <Input defaultValue="pi" />
    <FieldDescription>pi is unreachable. Re-check before you change this.</FieldDescription>
  </Field>
);

export const WithSwitch = () => (
  <Field style={{ maxWidth: '20rem' }}>
    <FieldItem style={{ alignItems: 'center', gap: '0.75rem' }}>
      <Switch defaultChecked />
      <FieldLabel>Notify on crash</FieldLabel>
    </FieldItem>
    <FieldDescription>Sends a push through ntfy when the agent exits non-zero.</FieldDescription>
  </Field>
);
