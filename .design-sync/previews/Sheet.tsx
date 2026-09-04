import {
  Button,
  Sheet,
  SheetClose,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from 'yantra-web';

const rows: [string, string][] = [
  ['Machine', 'macbook'],
  ['Path', '~/code/yantra'],
  ['Agent', 'claude, running for 12 s'],
  ['tmux session', 'yantra-yantra'],
  ['Last load', '0.42 · 0.38 · 0.31'],
  ['Tailscale', '100.64.0.12'],
];

const Detail = () => (
  <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: '1rem', rowGap: '0.5rem', margin: 0, fontSize: '0.875rem' }}>
    {rows.map(([k, v]) => (
      <>
        <dt key={`${k}-k`} style={{ color: 'var(--muted-foreground)' }}>{k}</dt>
        <dd key={`${k}-v`} style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{v}</dd>
      </>
    ))}
  </dl>
);

export const WorkspaceDetail = () => (
  <Sheet open>
    <SheetTrigger render={<Button variant="outline" />}>yantra</SheetTrigger>
    <SheetPopup side="right">
      <SheetHeader>
        <SheetTitle>yantra</SheetTitle>
        <SheetDescription>Workspace on macbook. Read 9 seconds ago.</SheetDescription>
      </SheetHeader>
      <SheetPanel>
        <Detail />
      </SheetPanel>
      <SheetFooter>
        <SheetClose render={<Button variant="outline" />}>Close</SheetClose>
        <Button variant="secondary">Attach</Button>
        <Button variant="destructive">Stop</Button>
      </SheetFooter>
    </SheetPopup>
  </Sheet>
);

export const UnreachableMachine = () => (
  <Sheet open>
    <SheetTrigger render={<Button variant="outline" />}>pi</SheetTrigger>
    <SheetPopup side="bottom" showCloseButton={false}>
      <SheetHeader>
        <SheetTitle>pi is unreachable</SheetTitle>
        <SheetDescription>
          ssh: connect to host pi port 22: No route to host. The infra workspace keeps its last
          known state until the next check.
        </SheetDescription>
      </SheetHeader>
      <SheetFooter variant="bare">
        <SheetClose render={<Button variant="ghost" />}>Dismiss</SheetClose>
        <Button variant="outline">Re-check</Button>
      </SheetFooter>
    </SheetPopup>
  </Sheet>
);
