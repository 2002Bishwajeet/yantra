import { joinCommand } from '@/lib/join'
import { Copyable } from '@/m3/copyable/Copyable'
import { Text } from '@/m3/text/Text'

/** The join command where it can be built, and why not where it cannot. */
export function Join(props: { url: string | null; about: { error: Error | null; data: unknown }; what: string }) {
  const { url, about, what } = props
  if (url) return <Copyable text={joinCommand(url)} what={what} />
  return (
    <Text scale="body-small" tone="variant">
      {about.error
        ? "the daemon's address could not be read, so the join command cannot be built"
        : about.data
          ? 'the daemon reports no tailnet address, so the join command cannot be built · check that Tailscale is up on the appliance, then restart yantrad'
          : "reading the daemon's address…"}
    </Text>
  )
}
