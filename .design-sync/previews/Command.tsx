import {
  Command,
  CommandCollection,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
  CommandShortcut,
} from 'yantra-web';

type Entry = { kind: 'workspace' | 'machine' | 'route'; value: string; label: string; key?: string };
type Group = { label: string; items: Entry[] };

const GROUPS: Group[] = [
  {
    label: 'Workspaces',
    items: [
      { kind: 'workspace', value: 'yantra', label: 'yantra' },
      { kind: 'workspace', value: 'site', label: 'site' },
    ],
  },
  {
    label: 'Machines',
    items: [
      { kind: 'machine', value: 'macbook', label: 'macbook' },
      { kind: 'machine', value: 'cachyos-g14', label: 'cachyos-g14' },
    ],
  },
  {
    label: 'Routes',
    items: [
      { kind: 'route', value: '/', label: 'Fleet', key: 'G F' },
      { kind: 'route', value: '/new', label: 'New workspace', key: 'N' },
    ],
  },
];

export const Palette = () => (
  <div
    style={{
      width: '32rem',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-2xl)',
      background: 'var(--popover)',
      overflow: 'hidden',
    }}
  >
    <Command items={GROUPS}>
      <CommandInput aria-label="Search" placeholder="Workspaces, machines and routes" />
      <CommandPanel>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandList>
          {(group: Group) => (
            <CommandGroup items={group.items} key={group.label}>
              <CommandGroupLabel>{group.label}</CommandGroupLabel>
              <CommandCollection>
                {(entry: Entry) => (
                  <CommandItem key={`${entry.kind}:${entry.value}`} value={entry}>
                    {entry.label}
                    {entry.key && <CommandShortcut>{entry.key}</CommandShortcut>}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </CommandPanel>
    </Command>
  </div>
);
