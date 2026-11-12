import { Popover, PopoverPopup } from '@/m3/popover/Popover'
import { Text } from '@/m3/text/Text'
import { guardOutsidePress, useReady, type PopupProps } from '@/shell/useReady'

/** The reason behind a kept reading, without its trigger: the mark owns that element. */
export function KeptReadingWhy(props: PopupProps & { reason: string }) {
  // Never born open: a popover born open skips the enter spring.
  const ready = useReady()
  return (
    <Popover onOpenChange={guardOutsidePress(props)} open={props.open && ready}>
      <PopoverPopup
        align="start"
        anchor={props.anchor}
        className="kept__why"
        finalFocus={props.anchor}
        showTitle
        title="The last GitHub read failed"
      >
        <Text render={<p />} scale="body-medium">
          {props.reason}
        </Text>
        <Text render={<p />} scale="body-medium" tone="variant">
          Yantra shows the reading before it and reads GitHub again.
        </Text>
      </PopoverPopup>
    </Popover>
  )
}
