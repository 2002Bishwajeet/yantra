import { Button, Field, FieldDescription, FieldError, FieldLabel, Form, Input } from 'yantra-web';

export const AddWorkspace = () => (
  <Form style={{ maxWidth: '24rem' }}>
    <Field>
      <FieldLabel>Name</FieldLabel>
      <Input defaultValue="site" />
      <FieldDescription>Shown in the sidebar and the palette.</FieldDescription>
    </Field>
    <Field>
      <FieldLabel>Directory</FieldLabel>
      <Input defaultValue="~/code/site" />
    </Field>
    <Field>
      <FieldLabel>Machine</FieldLabel>
      <Input defaultValue="macbook" />
      <FieldDescription>One of macbook, cachyos-g14 or pi.</FieldDescription>
    </Field>
    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
      <Button variant="ghost">Cancel</Button>
      <Button>Add workspace</Button>
    </div>
  </Form>
);

export const WithErrors = () => (
  <Form style={{ maxWidth: '24rem' }}>
    <Field invalid>
      <FieldLabel>Name</FieldLabel>
      <Input defaultValue="api" aria-invalid />
      <FieldError match>A workspace named api already exists on cachyos-g14.</FieldError>
    </Field>
    <Field invalid>
      <FieldLabel>Directory</FieldLabel>
      <Input defaultValue="/srv/api" aria-invalid />
      <FieldError match>Not a git repository. Yantra needs one to name the workspace.</FieldError>
    </Field>
    <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
      <Button variant="ghost">Cancel</Button>
      <Button disabled>Add workspace</Button>
    </div>
  </Form>
);
