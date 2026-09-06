import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from 'yantra-web';

export const Workspace = () => (
  <Card style={{ maxWidth: '24rem' }}>
    <CardHeader>
      <CardTitle>yantra</CardTitle>
      <CardDescription>~/code/yantra on macbook</CardDescription>
      <CardAction>
        <Badge>running</Badge>
      </CardAction>
    </CardHeader>
    <CardContent>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: '1rem', rowGap: '0.25rem', margin: 0 }}>
        <dt style={{ color: 'var(--color-muted-foreground)' }}>Agent</dt>
        <dd style={{ margin: 0 }}>claude, attached 12 s ago</dd>
        <dt style={{ color: 'var(--color-muted-foreground)' }}>Session</dt>
        <dd style={{ margin: 0 }}>tmux yantra:0</dd>
      </dl>
    </CardContent>
    <CardFooter style={{ gap: '0.5rem' }}>
      <Button size="sm">Attach</Button>
      <Button size="sm" variant="outline">Transcript</Button>
      <Button size="sm" variant="destructive-outline" style={{ marginLeft: 'auto' }}>Stop</Button>
    </CardFooter>
  </Card>
);

export const Small = () => (
  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
    <Card size="sm" style={{ width: '13rem' }}>
      <CardHeader>
        <CardTitle>macbook</CardTitle>
        <CardDescription>2 workspaces</CardDescription>
      </CardHeader>
      <CardContent>Reachable, tmux 3.5a</CardContent>
    </Card>
    <Card size="sm" style={{ width: '13rem' }}>
      <CardHeader>
        <CardTitle>cachyos-g14</CardTitle>
        <CardDescription>2 workspaces</CardDescription>
      </CardHeader>
      <CardContent>Reachable, tmux 3.5a</CardContent>
    </Card>
    <Card size="sm" style={{ width: '13rem' }}>
      <CardHeader>
        <CardTitle>pi</CardTitle>
        <CardDescription>1 workspace</CardDescription>
      </CardHeader>
      <CardContent>Unreachable for 2 h</CardContent>
    </Card>
  </div>
);

export const HeaderOnly = () => (
  <Card style={{ maxWidth: '24rem' }}>
    <CardHeader>
      <CardTitle>api</CardTitle>
      <CardDescription>Crashed on cachyos-g14, 3 min ago. The last line was a panic in the relay.</CardDescription>
      <CardAction>
        <Button size="sm" variant="outline">Resume</Button>
      </CardAction>
    </CardHeader>
  </Card>
);
