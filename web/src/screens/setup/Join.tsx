import { useJoinCommand } from '@/api/passkey'
import { Copyable } from '@/m3/copyable/Copyable'
import { Text } from '@/m3/text/Text'

/** The join command with a fresh code (ADR-0044 decision 13), or why there is
 *  none. `machine` keeps each machine's code apart, since a code works once. */
export function Join(props: { machine: string; what: string }) {
  const { machine, what } = props
  const command = useJoinCommand(machine)
  if (command.data) {
    return (
      <>
        <Copyable text={command.data.command} what={what} />
        <Text scale="body-small" tone="variant">
          The code in it works once, within 10 minutes. This page makes a new one before then.
        </Text>
      </>
    )
  }
  return (
    <Text scale="body-small" tone="variant">
      {command.error
        ? `the join command could not be made · ${command.error.describe()} ${command.error.said}`
        : 'making a join command…'}
    </Text>
  )
}
