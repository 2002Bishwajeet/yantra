import { ExternalLink, FileKey, Scale } from 'lucide-react'
import { useAbout } from '@/api/hooks'
import { Lead } from '@/m3/lead/Lead'
import { ListChevron, ListItem } from '@/m3/list/List'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { Group, Note } from './Group'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** `YYYY-MM-DD` as the brief's date: `6 Sep`. */
function built(date: string): string {
  const [, month, day] = date.split('-').map(Number)
  return month && day ? `${day} ${MONTHS[month - 1]}` : date
}

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86_400)
  const h = Math.floor((seconds % 86_400) / 3_600)
  const m = Math.floor((seconds % 3_600) / 60)
  if (d) return `${d}d ${h}h`
  if (h) return `${h}h ${m}m`
  return `${m}m`
}

export function About() {
  const about = useAbout()
  if (about.error) throw about.error
  const facts = about.data

  return (
    <>
      <section aria-label="Daemon" className="settings__about">
        {facts ? (
          <Text render={<p />} className="settings__version" scale="title-large" emphasized>
            yantrad <Mono>{facts.version}</Mono> · built {built(facts.built)} · running
          </Text>
        ) : (
          <Skeleton shape="text" />
        )}
        <dl className="settings__facts">
          <Fact label="Target" value={facts ? <Mono>{facts.target}</Mono> : null} />
          <Fact label="Uptime" value={facts ? <Mono>{uptime(facts.uptime_seconds)}</Mono> : null} />
          <Fact label="Listens on" value={facts ? <Mono>{facts.listening_on.join(' · ')}</Mono> : null} />
          <Fact label="Reached at" value={<Mono>{location.host}</Mono>} />
        </dl>
      </section>
      <Group label="Daemon">
        <ListItem
          headline={<Mono>/etc/yantra/daemon.env</Mono>}
          leading={
            <Lead>
              <FileKey />
            </Lead>
          }
          supporting="0600 · the one file the daemon writes · the relay and the GitHub grant"
        />
      </Group>
      <Group label="Project">
        <ListItem
          headline="Licence"
          leading={
            <Lead>
              <Scale />
            </Lead>
          }
          supporting="BSD 3-Clause · Bishwajeet Parhi, 2026"
        />
        <ListItem
          headline="Source"
          leading={
            <Lead>
              <ExternalLink />
            </Lead>
          }
          render={<a href="https://github.com/2002Bishwajeet/yantra" rel="noreferrer" target="_blank" />}
          supporting="github.com/2002Bishwajeet/yantra"
          trailing={<ListChevron />}
        />
      </Group>
      <Note>Yantra persists nothing about the fleet. What you see on the dashboard is read from the machines each time.</Note>
    </>
  )
}

function Fact(props: { label: string; value: React.ReactNode }) {
  const { label, value } = props
  return (
    <div className="settings__fact">
      <dt>
        <Text scale="label-medium" tone="variant">
          {label}
        </Text>
      </dt>
      <dd>{value ?? <Skeleton shape="text" />}</dd>
    </div>
  )
}
