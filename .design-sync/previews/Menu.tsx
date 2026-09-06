import {
  Button,
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from 'yantra-web';

export const RowOverflow = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.875rem' }}>
    <span style={{ fontWeight: 500 }}>api</span>
    <span style={{ color: 'var(--muted-foreground)' }}>cachyos-g14 · crashed 3 min ago</span>
    <Menu open>
      <MenuTrigger render={<Button variant="ghost" size="icon" aria-label="More" />}>⋯</MenuTrigger>
      <MenuPopup align="start" style={{ width: '13rem' }}>
        <MenuGroup>
          <MenuGroupLabel>api on cachyos-g14</MenuGroupLabel>
          <MenuItem>
            Resume
            <MenuShortcut>R</MenuShortcut>
          </MenuItem>
          <MenuItem>
            Attach
            <MenuShortcut>A</MenuShortcut>
          </MenuItem>
          <MenuItem disabled>
            Stop
            <MenuShortcut>S</MenuShortcut>
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem>Kill session</MenuItem>
        <MenuItem variant="destructive">Delete workspace</MenuItem>
      </MenuPopup>
    </Menu>
  </div>
);
