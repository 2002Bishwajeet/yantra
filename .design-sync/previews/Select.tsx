import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from 'yantra-web';

const AGENTS = [
  { label: 'Agents', items: ['claude', 'codex', 'gemini', 'opencode'] },
  { label: 'Shells', items: ['bash', 'zsh', 'fish'] },
];

export const Agent = () => (
  <div style={{ width: '16rem' }}>
    <Select defaultValue="claude" open>
      <SelectTrigger aria-label="Agent">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {AGENTS.map((group) => (
          <SelectGroup key={group.label}>
            <SelectGroupLabel>{group.label}</SelectGroupLabel>
            {group.items.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  </div>
);

export const Triggers = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', width: '16rem' }}>
    <Select defaultValue="macbook">
      <SelectTrigger aria-label="Machine">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="macbook">macbook</SelectItem>
        <SelectItem value="cachyos-g14">cachyos-g14</SelectItem>
        <SelectItem value="pi">pi</SelectItem>
      </SelectPopup>
    </Select>
    <Select>
      <SelectTrigger aria-label="Machine" size="sm">
        <SelectValue placeholder="Choose a machine" />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="macbook">macbook</SelectItem>
        <SelectItem value="pi">pi</SelectItem>
      </SelectPopup>
    </Select>
    <Select defaultValue="pi">
      <SelectTrigger aria-label="Machine" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="macbook">macbook</SelectItem>
        <SelectItem value="pi">pi</SelectItem>
      </SelectPopup>
    </Select>
    <Select defaultValue="cachyos-g14" disabled>
      <SelectTrigger aria-label="Machine">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value="cachyos-g14">cachyos-g14</SelectItem>
      </SelectPopup>
    </Select>
  </div>
);
