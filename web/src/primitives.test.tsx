/**
 * The primitives ported from T3 Code. Y-164, and the overlays in Y-166.
 *
 * Their behaviour is Base UI's and is not re-tested here. What this pins is the
 * port itself: every file mounts under this repo's React and `@base-ui/react`,
 * and the tokens the port added to `index.css` are still the ones the class
 * strings ask for — a renamed token is otherwise silent, and the button simply
 * loses its radius.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Autocomplete, AutocompleteInput } from './components/ui/autocomplete'
import { Button } from './components/ui/button'
import { Combobox, ComboboxInput } from './components/ui/combobox'
import { Command, CommandInput, CommandList } from './components/ui/command'
import { Dialog, DialogPopup, DialogTrigger } from './components/ui/dialog'
import { Menu, MenuItem, MenuPopup, MenuTrigger } from './components/ui/menu'
import { Select, SelectItem, SelectPopup, SelectTrigger } from './components/ui/select'
import { Sheet, SheetPopup, SheetTrigger } from './components/ui/sheet'
import { Spinner } from './components/ui/spinner'
import {
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
} from './components/ui/collapsible'
import { Field, FieldError, FieldLabel } from './components/ui/field'
import { Form } from './components/ui/form'
import { Input } from './components/ui/input'
import { Kbd, KbdGroup } from './components/ui/kbd'
import { Label } from './components/ui/label'
import {
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from './components/ui/popover'
import { ScrollArea } from './components/ui/scroll-area'
import { Separator } from './components/ui/separator'
import { Skeleton } from './components/ui/skeleton'
import { Switch } from './components/ui/switch'
import { Toggle } from './components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from './components/ui/toggle-group'
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from './components/ui/tooltip'

afterEach(cleanup)

/** Base UI marks every part with `data-slot`, so one query covers all of them. */
const mounts: [string, () => React.ReactNode][] = [
  ['button', () => <Button>go</Button>],
  [
    'collapsible-trigger',
    () => (
      <Collapsible>
        <CollapsibleTrigger>more</CollapsibleTrigger>
        <CollapsiblePanel>body</CollapsiblePanel>
      </Collapsible>
    ),
  ],
  [
    'field',
    () => (
      <Field>
        <FieldLabel>name</FieldLabel>
        <Input />
        <FieldError />
      </Field>
    ),
  ],
  ['form', () => <Form />],
  ['input', () => <Input />],
  [
    'kbd-group',
    () => (
      <KbdGroup>
        <Kbd>⌘</Kbd>
      </KbdGroup>
    ),
  ],
  ['label', () => <Label>label</Label>],
  [
    'popover-trigger',
    () => (
      <Popover open>
        <PopoverTrigger>open</PopoverTrigger>
        <PopoverPopup>inside</PopoverPopup>
      </Popover>
    ),
  ],
  ['scroll-area-viewport', () => <ScrollArea>scrolls</ScrollArea>],
  ['separator', () => <Separator />],
  ['skeleton', () => <Skeleton />],
  ['switch', () => <Switch />],
  ['toggle', () => <Toggle>bold</Toggle>],
  [
    'toggle-group',
    () => (
      <ToggleGroup>
        <ToggleGroupItem value="a">a</ToggleGroupItem>
      </ToggleGroup>
    ),
  ],
  [
    'tooltip-trigger',
    () => (
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger>hover</TooltipTrigger>
          <TooltipPopup>hint</TooltipPopup>
        </Tooltip>
      </TooltipProvider>
    ),
  ],

  // Y-166 — the overlays, which needed lucide-react
  [
    'autocomplete-input',
    () => (
      <Autocomplete items={['a', 'b']}>
        <AutocompleteInput />
      </Autocomplete>
    ),
  ],
  [
    'combobox-input',
    () => (
      <Combobox items={['a', 'b']}>
        <ComboboxInput />
      </Combobox>
    ),
  ],
  [
    'command-list',
    () => (
      <Command items={['a', 'b']}>
        <CommandInput />
        <CommandList>{(item: string) => <span key={item}>{item}</span>}</CommandList>
      </Command>
    ),
  ],
  [
    'dialog-popup',
    () => (
      <Dialog open>
        <DialogTrigger>open</DialogTrigger>
        <DialogPopup>inside</DialogPopup>
      </Dialog>
    ),
  ],
  [
    'menu-popup',
    () => (
      <Menu open>
        <MenuTrigger>open</MenuTrigger>
        <MenuPopup>
          <MenuItem>one</MenuItem>
        </MenuPopup>
      </Menu>
    ),
  ],
  [
    'select-popup',
    () => (
      <Select defaultValue="a" open>
        <SelectTrigger>a</SelectTrigger>
        <SelectPopup>
          <SelectItem value="a">a</SelectItem>
        </SelectPopup>
      </Select>
    ),
  ],
  [
    'sheet-popup',
    () => (
      <Sheet open>
        <SheetTrigger>open</SheetTrigger>
        <SheetPopup>inside</SheetPopup>
      </Sheet>
    ),
  ],
]

describe('the ported primitives', () => {
  it.each(mounts)('%s mounts', (slot, subject) => {
    render(subject())
    expect(document.querySelector(`[data-slot="${slot}"]`)).not.toBeNull()
  })

  /** The one file that renders a lucide icon and nothing else, so it carries no
   *  `data-slot` to query. */
  it('spinner mounts', () => {
    render(<Spinner />)
    expect(screen.getByRole('status')).not.toBeNull()
  })
})

describe('the tokens the port added to index.css', () => {
  it('is what the button asks for', () => {
    render(<Button>go</Button>)
    const cls = screen.getByRole('button').className
    expect(cls).toContain('rounded-[var(--control-radius)]')
    expect(cls).toContain('text-[var(--control-icon-color)]')
  })

  /** The scroll-area thumb carries `--app-scrollbar-thumb` and is not asserted
   *  here: Base UI omits both scrollbars when nothing overflows, and jsdom
   *  measures every box as zero. */
  it('is what the skeleton asks for', () => {
    const { container } = render(<Skeleton />)
    expect(container.innerHTML).toContain('animate-skeleton')
  })

  /** A popup with no `.dropdown-glass` rule has no background at all, so the
   *  class name is the whole contract between the copy and `index.css`. */
  it('is the glass class the overlays name', () => {
    render(
      <Menu open>
        <MenuTrigger>open</MenuTrigger>
        <MenuPopup>
          <MenuItem>one</MenuItem>
        </MenuPopup>
      </Menu>,
    )
    const popup = document.querySelector('[data-slot="menu-popup"]')
    expect(popup?.className).toContain('dropdown-glass')

    cleanup()
    render(
      <Dialog open>
        <DialogTrigger>open</DialogTrigger>
        <DialogPopup>inside</DialogPopup>
      </Dialog>,
    )
    const dialog = document.querySelector('[data-slot="dialog-popup"]')
    expect(dialog?.className).toContain('dialog-glass')
  })
})
