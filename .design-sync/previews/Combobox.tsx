import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from 'yantra-web';

type Dir = { path: string; name: string; repo: boolean; origin: string | null };

const ENTRIES: Dir[] = [
  { path: '/home/biswa', name: '..', repo: false, origin: null },
  { path: '/home/biswa/code/yantra', name: 'yantra', repo: true, origin: 'github.com/2002Bishwajeet/yantra' },
  { path: '/home/biswa/code/site', name: 'site', repo: true, origin: 'github.com/2002Bishwajeet/site' },
  { path: '/home/biswa/code/api', name: 'api', repo: true, origin: 'github.com/2002Bishwajeet/api' },
  { path: '/home/biswa/code/infra', name: 'infra', repo: true, origin: 'github.com/2002Bishwajeet/infra' },
  { path: '/home/biswa/code/notes', name: 'notes', repo: true, origin: null },
  { path: '/home/biswa/code/scratch', name: 'scratch', repo: false, origin: null },
  { path: '/home/biswa/code/yantra-landing', name: 'yantra-landing', repo: true, origin: 'github.com/2002Bishwajeet/yantra' },
];

export const Directories = () => (
  <div style={{ width: '26rem' }}>
    <Combobox<Dir>
      defaultInputValue="~/code/"
      filter={() => true}
      items={ENTRIES}
      itemToStringLabel={(entry) => entry.name}
      open
      value={null}
    >
      <ComboboxInput aria-label="Directory" placeholder="/" showTrigger={false} />
      <ComboboxPopup>
        <ComboboxEmpty>nothing here matches</ComboboxEmpty>
        <ComboboxList>
          {(entry: Dir) => (
            <ComboboxItem key={entry.path} value={entry}>
              <span style={{ fontFamily: "'IBM Plex Mono', ui-monospace, SFMono-Regular, monospace" }}>
                {entry.name === '..' ? '..' : `${entry.name}/`}
              </span>
              {entry.name !== '..' && (
                <span style={{ marginInlineStart: '0.5rem', fontSize: '0.75rem', color: 'var(--muted-foreground)' }}>
                  {entry.origin ?? (entry.repo ? 'no origin' : 'not a repository')}
                </span>
              )}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  </div>
);

const MACHINES = ['macbook', 'cachyos-g14', 'pi', 'nas', 'mini', 'vps'];

export const Machines = () => (
  <div style={{ width: '26rem' }}>
    <Combobox defaultValue={['macbook', 'pi']} items={MACHINES} multiple open>
      <ComboboxChips>
        <ComboboxValue>
          {(names: string[]) => (
            <>
              {names.map((name) => (
                <ComboboxChip aria-label={name} key={name}>
                  {name}
                </ComboboxChip>
              ))}
              <ComboboxChipsInput aria-label="Machines" placeholder="Add a machine" />
            </>
          )}
        </ComboboxValue>
      </ComboboxChips>
      <ComboboxPopup>
        <ComboboxEmpty>No machine matches.</ComboboxEmpty>
        <ComboboxList>
          {(name: string) => (
            <ComboboxItem key={name} value={name}>
              {name}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  </div>
);
