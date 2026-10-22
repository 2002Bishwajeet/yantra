/*
 * Adapted from T3 Code at 810e8f6, apps/web/src/components/chat/ComposerAttachmentStrip.tsx,
 * ComposerImageThumbnail.tsx and ExpandedImageDialog.tsx, for images only:
 * https://github.com/pingdotgg/t3code/blob/810e8f62f0eff2f3b6ae4602f781d9bb80607913/apps/web/src/components/chat/ComposerAttachmentStrip.tsx
 * Copyright (c) 2026 T3 Tools Inc. Used under the MIT licence; the full text is in
 * THIRD_PARTY_NOTICES.md at the repository root.
 */
import { memo, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, CircleAlert, ImageOff, X } from 'lucide-react'
import { Dialog, DialogPopup } from '@/m3/dialog/Dialog'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { IconButton } from '@/m3/icon-button/IconButton'
import type { Picked } from './useImages'

/** Memoised so a keystroke in the field does not decode the picture again. */
const Thumbnail = memo(function Thumbnail(props: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false)
  // A file the browser cannot draw, such as a PDF the chat refused, gets a glyph rather than a broken image.
  if (broken) return <ImageOff aria-label={props.alt} className="composer-tile__broken" role="img" />
  return <img alt={props.alt} decoding="async" onError={() => setBroken(true)} src={props.src} />
})

function Preview(props: { images: Picked[]; at: number; onClose: () => void }) {
  const { images, onClose } = props
  const [offset, setOffset] = useState(0)
  const count = images.length
  // `%` keeps the sign of the dividend, and a negative index would blank the dialog.
  const at = (((props.at + offset) % count) + count) % count
  const one = images[at]
  if (!one) return null
  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogPopup dismiss="Close the preview" title={`Image ${at + 1}`}>
        <div
          className="composer-preview"
          onKeyDown={(event) => {
            if (count < 2 || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
            event.preventDefault()
            setOffset((now) => now + (event.key === 'ArrowLeft' ? -1 : 1))
          }}
        >
          <img alt={`Image ${at + 1} in full`} src={one.url} />
          {count > 1 ? (
            <div className="composer-preview__nav">
              <IconButton label="Previous image" onClick={() => setOffset((now) => now - 1)} type="button">
                <ChevronLeft />
              </IconButton>
              <IconButton label="Next image" onClick={() => setOffset((now) => now + 1)} type="button">
                <ChevronRight />
              </IconButton>
            </div>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  )
}

/** The composer's images: a tile for each, its upload state, and a line saying
 *  why for each that failed. */
export function Attachments(props: { images: Picked[]; onRemove: (id: number) => void }) {
  const { images, onRemove } = props
  const [previewing, setPreviewing] = useState<number | null>(null)
  if (images.length === 0) return null
  return (
    <>
      <ul aria-label="Images" aria-live="polite" className="composer-images">
        {images.map((one, at) => (
          <li className="composer-tile" data-state={one.state} key={one.id}>
            <button
              aria-label={`Preview image ${at + 1}`}
              className="composer-tile__open"
              onClick={() => setPreviewing(at)}
              type="button"
            >
              <Thumbnail alt={`Image ${at + 1}`} src={one.url} />
            </button>
            {one.state === 'uploading' ? (
              <span className="composer-tile__badge">
                <span aria-hidden="true" className="composer-spinner" style={{ width: 12, height: 12 }} />
                <span className="m3-sr-only">Uploading…</span>
              </span>
            ) : one.state === 'attached' ? (
              <span className="composer-tile__badge">
                <Check aria-hidden="true" />
                <span className="m3-sr-only">Attached</span>
              </span>
            ) : (
              <span className="composer-tile__badge">
                <CircleAlert aria-hidden="true" />
                <span className="m3-sr-only">Not attached</span>
              </span>
            )}
            <IconButton
              className="composer-tile__remove"
              label={`Remove image ${at + 1}`}
              onClick={() => onRemove(one.id)}
              type="button"
            >
              <X />
            </IconButton>
          </li>
        ))}
      </ul>
      {images.some((one) => one.state === 'failed') ? (
        <div className="composer-faults">
          {images.map((one, at) =>
            one.state === 'failed' ? (
              <ErrorSurface.Inline error={one.error} key={one.id} title={`Image ${at + 1} is not attached`} />
            ) : null,
          )}
        </div>
      ) : null}
      {previewing !== null ? <Preview at={previewing} images={images} onClose={() => setPreviewing(null)} /> : null}
    </>
  )
}
