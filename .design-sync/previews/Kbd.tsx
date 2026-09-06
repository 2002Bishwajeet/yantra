import { Kbd, KbdGroup } from 'yantra-web';

export const Shortcuts = () => (
  <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
    <Kbd>⌘K</Kbd>
    <Kbd>Esc</Kbd>
    <Kbd>↵</Kbd>
    <Kbd>/</Kbd>
  </div>
);

export const Groups = () => (
  <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
    <KbdGroup>
      <Kbd>⌘</Kbd>
      <Kbd>K</Kbd>
    </KbdGroup>
    <KbdGroup>
      <Kbd>Ctrl</Kbd>
      <Kbd>B</Kbd>
      <Kbd>D</Kbd>
    </KbdGroup>
    <KbdGroup>
      <Kbd>⇧</Kbd>
      <Kbd>⌘</Kbd>
      <Kbd>A</Kbd>
    </KbdGroup>
  </div>
);

export const InText = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: '24rem', fontSize: '0.875rem' }}>
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
      Open the command palette <Kbd>⌘K</Kbd>
    </span>
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
      Attach to the session
      <KbdGroup><Kbd>⌘</Kbd><Kbd>↵</Kbd></KbdGroup>
    </span>
    <span style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
      Detach from tmux
      <KbdGroup><Kbd>Ctrl</Kbd><Kbd>B</Kbd><Kbd>D</Kbd></KbdGroup>
    </span>
  </div>
);
