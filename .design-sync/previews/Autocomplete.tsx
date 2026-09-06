import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from 'yantra-web';

type Dir = { machine: string; path: string };
type Group = { label: string; items: Dir[] };

const DIRS: Group[] = [
  {
    label: 'macbook',
    items: [
      { machine: 'macbook', path: '~/code/yantra' },
      { machine: 'macbook', path: '~/code/site' },
      { machine: 'macbook', path: '~/code/yantra-landing' },
      { machine: 'macbook', path: '~/notes' },
    ],
  },
  {
    label: 'cachyos-g14',
    items: [
      { machine: 'cachyos-g14', path: '~/code/yantra' },
      { machine: 'cachyos-g14', path: '~/code/api' },
      { machine: 'cachyos-g14', path: '~/code/infra' },
      { machine: 'cachyos-g14', path: '~/srv/homelab' },
    ],
  },
];

export const Directories = () => (
  <div style={{ width: '24rem' }}>
    <Autocomplete
      defaultValue="~/"
      items={DIRS}
      itemToStringLabel={(dir: Dir) => dir.path}
      open
    >
      <AutocompleteInput aria-label="Directory" placeholder="~/code/…" showTrigger />
      <AutocompletePopup>
        <AutocompleteEmpty>No directory matches.</AutocompleteEmpty>
        <AutocompleteList>
          {(group: Group) => (
            <AutocompleteGroup items={group.items} key={group.label}>
              <AutocompleteGroupLabel>{group.label}</AutocompleteGroupLabel>
              <AutocompleteCollection>
                {(dir: Dir) => (
                  <AutocompleteItem key={`${dir.machine}:${dir.path}`} value={dir}>
                    <span style={{ fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace" }}>{dir.path}</span>
                  </AutocompleteItem>
                )}
              </AutocompleteCollection>
            </AutocompleteGroup>
          )}
        </AutocompleteList>
      </AutocompletePopup>
    </Autocomplete>
  </div>
);
