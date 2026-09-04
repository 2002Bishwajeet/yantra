import {
  Button,
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from 'yantra-web';

export const DeleteWorkspace = () => (
  <Dialog open>
    <DialogTrigger render={<Button variant="destructive-outline" />}>Delete workspace</DialogTrigger>
    <DialogPopup bottomStickOnMobile={false}>
      <DialogHeader>
        <DialogTitle>Delete the workspace "site"?</DialogTitle>
        <DialogDescription>
          This removes site from the fleet and forgets its ~/code/site path on macbook. The
          directory and the git history stay where they are.
        </DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <p style={{ margin: 0, fontSize: '0.875rem' }}>
          An agent is awaiting trust in this workspace. Deleting the workspace kills that session
          first.
        </p>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
        <Button variant="destructive">Delete workspace</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>
);

export const KillSession = () => (
  <Dialog open>
    <DialogTrigger render={<Button variant="outline" />}>Kill session</DialogTrigger>
    <DialogPopup bottomStickOnMobile={false} showCloseButton={false}>
      <DialogHeader>
        <DialogTitle>Kill the session on cachyos-g14?</DialogTitle>
        <DialogDescription>
          The agent in api crashed 3 minutes ago and tmux still holds the pane. Kill it to free
          the session name; Resume starts a fresh one.
        </DialogDescription>
      </DialogHeader>
      <DialogFooter variant="bare">
        <DialogClose render={<Button variant="ghost" />}>Keep it</DialogClose>
        <Button variant="destructive">Kill session</Button>
      </DialogFooter>
    </DialogPopup>
  </Dialog>
);
