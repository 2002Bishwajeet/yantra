import { Alert, AlertAction, AlertDescription, AlertTitle, Button } from 'yantra-web';

export const Default = () => (
  <Alert style={{ maxWidth: '36rem' }}>
    <AlertTitle>The directory is a git repository</AlertTitle>
    <AlertDescription>
      ~/code/yantra on macbook. Origin github.com/2002Bishwajeet/yantra. The workspace name
      follows the directory until you edit it.
    </AlertDescription>
  </Alert>
);

export const Destructive = () => (
  <Alert variant="destructive" style={{ maxWidth: '36rem' }}>
    <AlertTitle>macbook could not be reached</AlertTitle>
    <AlertDescription>
      ssh: connect to host macbook port 22: Operation timed out. The workspace file is untouched;
      nothing was started.
    </AlertDescription>
  </Alert>
);

export const WithAction = () => (
  <Alert style={{ maxWidth: '36rem' }}>
    <AlertTitle>tmux is not installed on pi</AlertTitle>
    <AlertDescription>
      Every session runs inside tmux, so nothing can start here until it is. Install it, then ask
      again.
    </AlertDescription>
    <AlertAction>
      <Button size="sm" variant="outline">Re-check</Button>
    </AlertAction>
  </Alert>
);
