/**
 * Every component in every state, twice: Clean and Compact. Dev only; the
 * route in router.ts mounts it under `/m3` and Playwright screenshots it.
 * `?theme=dark|light` and `?density=compact` pin the root attributes.
 */
import { useEffect, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  BarChart3,
  Bell,
  Cpu,
  EllipsisVertical,
  GitBranch,
  Layers,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react'
import { ApiError } from '@/api/errors'
import { Badge } from '../badge/Badge'
import { BottomSheet, BottomSheetClose, BottomSheetPopup, BottomSheetTrigger } from '../bottom-sheet/BottomSheet'
import { Button } from '../button/Button'
import { Card } from '../card/Card'
import { Chip, FilterChip } from '../chip/Chip'
import { Dialog, DialogClose, DialogPopup, DialogTrigger } from '../dialog/Dialog'
import { Disclosure } from '../disclosure/Disclosure'
import { ErrorBoundary } from '../error-boundary/ErrorBoundary'
import { ErrorSurface } from '../error-surface/ErrorSurface'
import { ExtendedFab, Fab } from '../fab/Fab'
import { IconButton } from '../icon-button/IconButton'
import { Kbd } from '../kbd/Kbd'
import { Lead } from '../lead/Lead'
import { List, ListChevron, ListItem, ListValue } from '../list/List'
import { Mark, State, type MarkState } from '../mark/Mark'
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from '../menu/Menu'
import { BarDestination, NavigationBar } from '../navigation-bar/NavigationBar'
import { NavigationRail, RailDestination } from '../navigation-rail/NavigationRail'
import { Pill, PillGroup } from '../pill/Pill'
import { Popover, PopoverPopup, PopoverTrigger } from '../popover/Popover'
import { Row, RowText } from '../row/Row'
import { Segment, Segmented } from '../segmented/Segmented'
import { SideSheet } from '../side-sheet/SideSheet'
import { Skeleton } from '../skeleton/Skeleton'
import { Snackbar } from '../snackbar/Snackbar'
import { Stepper } from '../stepper/Stepper'
import { Switch } from '../switch/Switch'
import { Eyebrow, Mono, Text, type TypeScale } from '../text/Text'
import { TextField } from '../text-field/TextField'
import { IconTile, Tile } from '../tile/Tile'
import { TopAppBar } from '../top-app-bar/TopAppBar'
import { Track } from '../track/Track'
import './Gallery.css'

const scales: TypeScale[] = [
  'display-large', 'display-medium', 'display-small',
  'headline-large', 'headline-medium', 'headline-small',
  'title-large', 'title-medium', 'title-small',
  'body-large', 'body-medium', 'body-small',
  'label-large', 'label-medium', 'label-small',
]

const marks: MarkState[] = ['needs', 'running', 'idle', 'unknown', 'done', 'failed']

const network = new ApiError('network', 'fetch failed: ECONNREFUSED 100.64.0.7:7717')
const refused = new ApiError('refused', 'workspace landing has a live session', { status: 409 })

function Broken(): ReactNode {
  throw new RangeError('x is not iterable')
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="m3-gallery__section" aria-labelledby={`g-${props.title}`}>
      <Eyebrow render={<h3 />} id={`g-${props.title}`}>
        {props.title}
      </Eyebrow>
      <div className="m3-gallery__items">{props.children}</div>
    </section>
  )
}

function Catalogue() {
  const [sheetOpen, setSheetOpen] = useState(true)
  const [snack, setSnack] = useState(true)
  return (
    <div className="m3-gallery__catalogue">
      <Section title="Text">
        <div className="m3-gallery__stack">
          {scales.map((scale) => (
            <div key={scale} className="m3-gallery__pair">
              <Text scale={scale}>{scale}</Text>
              <Text scale={scale} emphasized>
                emphasized
              </Text>
            </div>
          ))}
          <div className="m3-gallery__pair">
            <Mono>3h 41m</Mono>
            <Eyebrow>Needs you</Eyebrow>
            <Text scale="body-medium" tone="variant">
              variant
            </Text>
            <Text scale="body-medium" tone="primary">
              primary
            </Text>
            <Text scale="body-medium" tone="error">
              error
            </Text>
          </div>
        </div>
      </Section>

      <Section title="Mark and State">
        {marks.map((state) => (
          <State key={state} state={state} />
        ))}
        {marks.map((state) => (
          <Mark key={state} state={state} size="small" />
        ))}
      </Section>

      <Section title="Button">
        {(['filled', 'tonal', 'outlined', 'text'] as const).map((variant) => (
          <div key={variant} className="m3-gallery__pair">
            <Button variant={variant}>{variant}</Button>
            <Button variant={variant} size="m" icon={<Plus />}>
              {variant} M
            </Button>
            <Button variant={variant} tone="error">
              Kill
            </Button>
            <Button variant={variant} disabled>
              disabled
            </Button>
          </div>
        ))}
      </Section>

      <Section title="IconButton">
        <IconButton label="Notifications">
          <Bell />
        </IconButton>
        <IconButton label="Notifications" variant="tonal" badge={<Badge count={3} label="3 unread" />}>
          <Bell />
        </IconButton>
        <IconButton label="New" variant="filled">
          <Plus />
        </IconButton>
        <IconButton label="Disabled" disabled>
          <Bell />
        </IconButton>
      </Section>

      <Section title="FAB">
        <Fab label="New session">
          <Plus />
        </Fab>
        <Fab label="New session" size="medium">
          <Plus />
        </Fab>
        <ExtendedFab icon={<Plus />}>New session</ExtendedFab>
      </Section>

      <Section title="Pill">
        <PillGroup>
          <Pill selected>Dashboard</Pill>
          <Pill>Fleet</Pill>
          <Pill>Machines</Pill>
          <Pill>Usage</Pill>
        </PillGroup>
        <Pill icon={<Search />}>Search anything</Pill>
        <Pill disabled>disabled</Pill>
      </Section>

      <Section title="Chip">
        <Chip>repo</Chip>
        <Chip tone="high">read:org</Chip>
        <Chip tone="primary" icon={<GitBranch />}>
          GitHub
        </Chip>
        <Chip tone="tertiary">2 unclaimed</Chip>
        <Chip tone="error">unreachable</Chip>
        <FilterChip defaultPressed>Running</FilterChip>
        <FilterChip>Idle</FilterChip>
        <FilterChip disabled>Never</FilterChip>
      </Section>

      <Section title="Badge and Kbd">
        <Badge label="new activity" />
        <Badge count={3} label="3 unread" />
        <Badge count={120} label="120 unread" />
        <Kbd>⌘K</Kbd>
        <Kbd>Esc</Kbd>
      </Section>

      <Section title="Tile and Lead">
        <Tile name="yantra-web" />
        <Tile name="landing" />
        <Tile name="homelab-k8s" size="small" />
        <IconTile>
          <GitBranch />
        </IconTile>
        <Lead>
          <GitBranch />
        </Lead>
        <Lead tone="primary">
          <Bell />
        </Lead>
        <Lead tone="tertiary">
          <Cpu />
        </Lead>
        <Lead tone="error">
          <Trash2 />
        </Lead>
      </Section>

      <Section title="Row and Track">
        <div className="m3-gallery__stack m3-gallery__wide">
          <Row tone="selected">
            <Tile name="yantra-web" />
            <RowText headline="yantra-web" supporting={<State state="needs" size="small">waiting for trust · cachyos-g14</State>} />
            <Mono>4m</Mono>
          </Row>
          <Row render={<a href="#row" />}>
            <Tile name="landing" />
            <RowText headline="landing" supporting={<State state="running" size="small">running · macbook</State>} />
            <Track value={1} label="elapsed, the longest" />
            <Mono>3h 41m</Mono>
          </Row>
          <Row tone="plain">
            <Tile name="price-table" size="small" />
            <RowText headline="price-table" supporting={<State state="idle" size="small">stopped · cachyos-g14</State>} />
            <Track value={0.33} label="elapsed" />
            <Mono>7 Jul</Mono>
            <Button variant="text">Open</Button>
          </Row>
          <Card surface="primary">
            <Row tone="translucent">
              <IconTile>
                <GitBranch />
              </IconTile>
              <RowText headline="Review requested: yantra#246" supporting="Y-331: the component library · 2h" />
              <Button>Review</Button>
            </Row>
          </Card>
        </div>
      </Section>

      <Section title="List">
        <div className="m3-gallery__wide">
          <List>
            <ListItem
              leading={
                <Lead>
                  <GitBranch />
                </Lead>
              }
              headline="GitHub"
              supporting="signed in as 2002Bishwajeet · repositories, reviews, issues"
              trailing={<Button variant="text">Manage</Button>}
            />
            <ListItem
              leading={
                <Lead>
                  <Bell />
                </Lead>
              }
              headline="Push to phone"
              supporting="ntfy.sh · Set · replaced 4 Sep"
              trailing={<Switch label="Push to phone" defaultChecked />}
            />
            <ListItem headline="Clone home" supporting="where a new workspace lands" trailing={<ListValue>~/Github</ListValue>} />
            <ListItem
              render={<a href="#appearance" />}
              headline="Appearance"
              supporting="Clean · sage · System"
              trailing={<ListChevron />}
            />
          </List>
        </div>
      </Section>

      <Section title="Card">
        <div className="m3-gallery__grid">
          <Card surface="primary">
            <Eyebrow>Needs you</Eyebrow>
            <Text scale="display-large" emphasized className="m3-gallery__hero">
              3
            </Text>
            <Text scale="title-medium">things are waiting on you</Text>
          </Card>
          <Card surface="high">
            <Text scale="title-large" emphasized render={<h4 />}>
              Running
            </Text>
            <Text scale="body-medium" tone="variant">
              4 sessions · longest 3h 41m
            </Text>
          </Card>
          <Card surface="tertiary">
            <Eyebrow>Worth a look</Eyebrow>
            <Text scale="body-medium">2 sessions no workspace claims</Text>
          </Card>
          <Card variant="outlined">
            <Eyebrow>Idle</Eyebrow>
            <Text scale="body-medium">8 workspaces, nothing running</Text>
          </Card>
          <Card variant="elevated">
            <Eyebrow>Elevated</Eyebrow>
            <Text scale="body-medium">surface-container-low, level 1</Text>
          </Card>
          <Card surface="error">
            <State state="failed">GitHub cannot be asked</State>
          </Card>
        </div>
      </Section>

      <Section title="TopAppBar">
        <div className="m3-gallery__phone">
          <TopAppBar
            title="Dashboard"
            leading={
              <IconButton label="Back">
                <ArrowLeft />
              </IconButton>
            }
            actions={
              <>
                <IconButton label="Notifications" badge={<Badge count={3} label="3 unread" />}>
                  <Bell />
                </IconButton>
                <IconButton label="Account" variant="tonal">
                  <span className="m3-gallery__avatar">B</span>
                </IconButton>
              </>
            }
          />
        </div>
      </Section>

      <Section title="NavigationRail and NavigationBar">
        <div className="m3-gallery__rail">
          <NavigationRail
            fab={
              <Fab label="New session">
                <Plus />
              </Fab>
            }
            trailing={
              <IconButton label="Notifications" variant="tonal" badge={<Badge count={3} label="3 unread" />}>
                <Bell />
              </IconButton>
            }
          >
            <RailDestination icon={<LayoutDashboard />} active>
              Dashboard
            </RailDestination>
            <RailDestination icon={<Layers />}>Fleet</RailDestination>
            <RailDestination icon={<Cpu />}>Machines</RailDestination>
            <RailDestination icon={<BarChart3 />}>Usage</RailDestination>
          </NavigationRail>
        </div>
        <div className="m3-gallery__phone">
          <NavigationBar>
            <BarDestination icon={<LayoutDashboard />} active>
              Dashboard
            </BarDestination>
            <BarDestination icon={<Layers />}>Fleet</BarDestination>
            <BarDestination icon={<Cpu />}>Machines</BarDestination>
            <BarDestination icon={<BarChart3 />}>Usage</BarDestination>
          </NavigationBar>
        </div>
      </Section>

      <Section title="Segmented and Switch">
        <Segmented label="Layout" defaultValue="clean">
          <Segment value="clean">Clean</Segment>
          <Segment value="compact">Compact</Segment>
        </Segmented>
        <Segmented label="Theme" defaultValue="system">
          <Segment value="light">Light</Segment>
          <Segment value="dark">Dark</Segment>
          <Segment value="system">System</Segment>
        </Segmented>
        <Switch label="Push to phone" defaultChecked />
        <Switch label="Quiet hours" />
        <Switch label="Disabled on" checked disabled />
        <Switch label="Disabled off" disabled />
      </Section>

      <Section title="TextField">
        <div className="m3-gallery__fields">
          <TextField label="Name" supporting="a word pair is fine" defaultValue="yantra-web" />
          <TextField label="Search repositories" leading={<Search />} />
          <TextField label="Clone home" variant="filled" defaultValue="~/Github" />
          <TextField label="Custom hex" variant="filled" error="That is not a colour." defaultValue="#zz" />
          <TextField label="Token" disabled defaultValue="Set · replaced 4 Sep" />
          <Card>
            <TextField label="Topic URL" defaultValue="https://ntfy.sh/yantra" />
          </Card>
        </div>
      </Section>

      <Section title="Stepper">
        <div className="m3-gallery__wide">
          <Stepper steps={['Name', 'Machine', 'Source', 'Start']} current={1} />
        </div>
      </Section>

      <Section title="Disclosure">
        <div className="m3-gallery__wide">
          <Disclosure
            summary={
              <>
                <Eyebrow>Idle</Eyebrow>
                <State state="idle">8 workspaces, nothing running · price-table, ntfy-relay and 6 more</State>
              </>
            }
          >
            <Text scale="body-medium">price-table · ntfy-relay · docs-sweep · landing-copy · cargo-zig</Text>
          </Disclosure>
          <Disclosure summary={<Eyebrow>Open</Eyebrow>} action="Hide" defaultOpen>
            <Text scale="body-medium">an opened one</Text>
          </Disclosure>
        </div>
      </Section>

      <Section title="Skeleton">
        <div className="m3-gallery__stack m3-gallery__wide">
          <Skeleton />
          <Skeleton style={{ width: '84%' }} />
          <div className="m3-gallery__pair">
            <Skeleton shape="round" />
            <Skeleton shape="text" style={{ width: 200 }} />
          </div>
        </div>
      </Section>

      <Section title="Snackbar">
        {snack ? (
          <Snackbar action={{ label: 'Undo', onClick: () => setSnack(false) }} onClose={() => setSnack(false)}>
            landing stopped
          </Snackbar>
        ) : (
          <Button variant="tonal" onClick={() => setSnack(true)}>
            Show snackbar
          </Button>
        )}
        <Snackbar tone="alert">thinkpad unreachable for 2h</Snackbar>
      </Section>

      <Section title="Dialog, BottomSheet, Popover, Menu">
        <Dialog>
          <DialogTrigger render={<Button variant="outlined" tone="error" />}>Kill landing</DialogTrigger>
          <DialogPopup
            title="Kill landing?"
            description="The tmux session on macbook and every process in it end now, and the agent gets no chance to finish its turn."
            actions={
              <>
                <DialogClose render={<Button variant="text" />}>Cancel</DialogClose>
                <DialogClose render={<Button tone="error" />}>Kill</DialogClose>
              </>
            }
          >
            <Row>
              <Tile name="landing" />
              <RowText headline="landing" supporting="macbook" />
              <State state="running" />
              <Mono>3h 41m</Mono>
            </Row>
          </DialogPopup>
        </Dialog>
        <BottomSheet>
          <BottomSheetTrigger render={<Button variant="outlined" />}>Bottom sheet</BottomSheetTrigger>
          <BottomSheetPopup
            title="Kill landing?"
            description="The tmux session on macbook and every process in it end now."
            actions={
              <>
                <BottomSheetClose render={<Button variant="text" />}>Cancel</BottomSheetClose>
                <BottomSheetClose render={<Button tone="error" />}>Kill</BottomSheetClose>
              </>
            }
          >
            <Row>
              <Tile name="landing" />
              <RowText headline="landing" supporting="running · macbook" />
              <Mono>3h 41m</Mono>
            </Row>
          </BottomSheetPopup>
        </BottomSheet>
        <Popover>
          <PopoverTrigger render={<IconButton label="Notifications" variant="tonal" />}>
            <Bell />
          </PopoverTrigger>
          <PopoverPopup title="Notifications" showTitle>
            <Row tone="plain">
              <Tile name="yantra-web" />
              <RowText headline="yantra-web is waiting for trust" supporting="asked 4m ago" />
            </Row>
          </PopoverPopup>
        </Popover>
        <Menu>
          <MenuTrigger render={<IconButton label="More" />}>
            <EllipsisVertical />
          </MenuTrigger>
          <MenuPopup>
            <MenuItem icon={<SettingsIcon />}>Settings</MenuItem>
            <MenuItem icon={<Bell />}>Notifications</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LogOut />} tone="error">
              Sign out
            </MenuItem>
            <MenuItem disabled>Disabled</MenuItem>
          </MenuPopup>
        </Menu>
      </Section>

      <Section title="SideSheet">
        {sheetOpen ? null : (
          <Button variant="tonal" onClick={() => setSheetOpen(true)}>
            Open side sheet
          </Button>
        )}
        <SideSheet
          title="Notifications"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          actions={
            <PillGroup>
              <Pill selected>Unread</Pill>
              <Pill>All</Pill>
            </PillGroup>
          }
        >
          <Row tone="plain">
            <Tile name="yantra-web" />
            <RowText headline="yantra-web is waiting for trust" supporting="asked 4m ago" />
          </Row>
          <Row tone="plain">
            <Tile name="homelab-k8s" />
            <RowText headline="homelab-k8s finished" supporting="pi-5 · 1h" />
          </Row>
        </SideSheet>
      </Section>

      <Section title="ErrorSurface">
        <div className="m3-gallery__stack m3-gallery__wide">
          <ErrorSurface.Page
            eyebrow="Fleet"
            title="Nothing here can be reached"
            error={network}
            reset={() => {}}
            unknowns={['off the tailnet', 'yantrad down']}
            meta="last good read 2m ago"
            action={<Button variant="text">Open Tailscale</Button>}
          />
          <div className="m3-gallery__grid">
            <ErrorSurface.Card eyebrow="Usage" title="Usage could not be read" error={network} reset={() => {}} meta="last good read 5m ago" />
            <ErrorSurface.Card eyebrow="Session" title="Stop was refused" error={refused} reset={() => {}} />
          </div>
          <ErrorSurface.Inline title="Transcript" error={network} reset={() => {}} />
        </div>
      </Section>

      <Section title="ErrorBoundary">
        <div className="m3-gallery__stack m3-gallery__wide">
          <ErrorBoundary eyebrow="Fleet" title="Fleet could not be drawn">
            <Broken />
          </ErrorBoundary>
          <ErrorBoundary layout="inline">
            <Broken />
          </ErrorBoundary>
        </div>
      </Section>
    </div>
  )
}

export function Gallery() {
  const params = new URLSearchParams(window.location.search)
  const [theme, setTheme] = useState(params.get('theme') ?? 'system')
  const [density, setDensity] = useState(params.get('density') ?? 'clean')
  useEffect(() => {
    const root = document.documentElement
    if (theme === 'system') delete root.dataset.theme
    else root.dataset.theme = theme
    root.dataset.density = density
  }, [theme, density])
  return (
    <div className="m3-gallery">
      <header className="m3-gallery__head">
        <Text scale="headline-small" emphasized render={<h1 />}>
          M3 gallery
        </Text>
        <Segmented label="Theme" value={theme} onValueChange={setTheme}>
          <Segment value="light">Light</Segment>
          <Segment value="dark">Dark</Segment>
          <Segment value="system">System</Segment>
        </Segmented>
        <Segmented label="Density" value={density} onValueChange={setDensity}>
          <Segment value="clean">Clean</Segment>
          <Segment value="compact">Compact</Segment>
        </Segmented>
      </header>
      <h2 className="m3-gallery__density">Clean</h2>
      <div data-density="clean">
        <Catalogue />
      </div>
      <h2 className="m3-gallery__density">Compact</h2>
      <div data-density="compact">
        <Catalogue />
      </div>
    </div>
  )
}
