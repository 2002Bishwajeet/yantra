import {
  Button,
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  Kbd,
} from 'yantra-web';

const FolderIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

export const NoWorkspaces = () => (
  <Empty style={{ maxWidth: '28rem' }}>
    <EmptyHeader>
      <EmptyMedia variant="icon">
        <FolderIcon />
      </EmptyMedia>
      <EmptyTitle>No workspaces yet</EmptyTitle>
      <EmptyDescription>
        A workspace is a directory on a machine. Add one and Yantra will keep a tmux session
        there for the agent.
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button size="sm">Add workspace</Button>
    </EmptyContent>
  </Empty>
);

export const NoTranscript = () => (
  <Empty style={{ maxWidth: '28rem' }}>
    <EmptyHeader>
      <EmptyTitle>Nothing to show for infra</EmptyTitle>
      <EmptyDescription>
        pi is unreachable, so the transcript could not be read. The last copy is 2 hours old.
      </EmptyDescription>
    </EmptyHeader>
    <EmptyContent>
      <Button size="sm" variant="outline">Re-check</Button>
    </EmptyContent>
  </Empty>
);

export const NoResults = () => (
  <Empty style={{ maxWidth: '28rem' }}>
    <EmptyHeader>
      <EmptyTitle>No sessions match "notes on pi"</EmptyTitle>
      <EmptyDescription>
        Try a workspace or a machine name, or press <Kbd>⌘K</Kbd> to open the palette.
      </EmptyDescription>
    </EmptyHeader>
  </Empty>
);
