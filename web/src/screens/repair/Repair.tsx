import { useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from '@tanstack/react-router'
import type { Broken } from '@/api'
import { asApiError, type ApiError } from '@/api/errors'
import { useRepairWorkspace } from '@/api/mutations'
import { repairQuery } from '@/api/queries'
import { Button } from '@/m3/button/Button'
import { Card } from '@/m3/card/Card'
import { ErrorBoundary } from '@/m3/error-boundary/ErrorBoundary'
import { ErrorSurface, type Described } from '@/m3/error-surface/ErrorSurface'
import { Mark, State } from '@/m3/mark/Mark'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { errorLine, shortError } from './line'
import './Repair.css'

/** ADR-0020's first bound, read: the daemon hands over no file that loads,
 *  and a name it does not know is the not-found board. */
function Refused(props: { name: string; error: unknown; reset: () => void }) {
  const { name, error, reset } = props
  const said = asApiError(error)
  const loads = said.status === 409
  const missing = said.kind === 'missing'
  const described: Described = {
    kind: said.kind,
    said: said.said,
    retryable: said.retryable,
    describe: loads
      ? () => 'That file loads, so there is nothing to repair.'
      : missing
        ? () => 'The fleet lists the ones there are.'
        : () => said.describe(),
  }
  return (
    <ErrorSurface.Page
      eyebrow="Repair"
      title={
        loads
          ? `${name} loads`
          : missing
            ? `No workspace is called ${name}.`
            : 'The file could not be read'
      }
      error={described}
      reset={reset}
      action={
        missing ? (
          <Button role="link" render={<Link to="/fleet" />} variant="tonal">
            Fleet
          </Button>
        ) : (
          <Button role="link" render={<Link params={{ name }} to="/w/$name" />} variant="tonal">
            Open {name}
          </Button>
        )
      }
    />
  )
}

/** The status alone, before the daemon's sentence: a 400 is the second
 *  bound and worth its own words. */
function refusal(error: ApiError): string {
  return error.status === 400 ? 'Those bytes still will not load.' : error.describe()
}

function Editor(props: {
  name: string
  file: Broken
  refused: ApiError | null
  saving: boolean
  onSave: (text: string) => void
}) {
  const { name, file, refused, saving, onSave } = props
  const [text, setText] = useState(file.text)
  const id = useId()
  const error = refused ? refused.said : file.error
  const line = errorLine(error)
  const lines = text.split('\n')
  const count = text.endsWith('\n') ? lines.length - 1 : lines.length

  const submit = (event: { preventDefault: () => void }) => {
    event.preventDefault()
    if (!saving) onSave(text)
  }

  return (
    <>
      <Card className="repair__alert" role="alert" surface="error">
        <State state="failed">will not load</State>
        <div className="repair__reason">
          <h2 className="repair__reason-title">
            {refused ? refusal(refused) : `${name} will not load.`}
          </h2>
          <Mono className="repair__error" id={`${id}-error`}>
            {error}
          </Mono>
        </div>
        <Text render={<p />} scale="body-small" className="repair__advice">
          Fix the file below and save. Save refuses bytes that still will not load, so a
          half-finished fix cannot be kept.
        </Text>
      </Card>

      <Card render={<form />} className="repair__file" onSubmit={submit}>
        <div className="repair__file-head">
          <div className="repair__file-name">
            <label className="m3-eyebrow" htmlFor={`${id}-text`}>
              The file
            </label>
            <Mono className="repair__count">{count} lines</Mono>
          </div>
          <Text scale="body-small" tone="variant">
            TOML. Three keys load: <Mono>machine</Mono>, <Mono>repo</Mono>, <Mono>startup</Mono>.
            Any other key is refused.
          </Text>
        </div>

        <div className="repair__editor">
          <div aria-hidden="true" className="repair__gutter">
            {lines.map((_, i) => (
              <span data-error={i + 1 === line ? '' : undefined} key={i}>
                {i + 1}
              </span>
            ))}
          </div>
          <div className="repair__text">
            {/* The mirror behind the textarea: it sizes the column, tints the
                line the error names and holds the marker. Readers get the
                textarea and the sentence it is described by. */}
            <div aria-hidden="true" className="repair__mirror">
              {lines.map((one, i) => (
                <div className="repair__line" data-error={i + 1 === line ? '' : undefined} key={i}>
                  <span>{one}</span>
                  {i + 1 === line ? (
                    <span className="repair__marker">
                      <Mark size="small" state="failed" />
                      {shortError(error)}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <textarea
              aria-describedby={`${id}-error`}
              aria-invalid="true"
              autoCapitalize="off"
              autoCorrect="off"
              className="repair__input"
              id={`${id}-text`}
              name="text"
              onChange={(event) => setText(event.target.value)}
              rows={lines.length}
              spellCheck={false}
              value={text}
              wrap="off"
            />
          </div>
        </div>

        <div className="repair__foot">
          <Text render={<p />} scale="body-small" tone="variant">
            Save writes the whole file. If it still will not load, the daemon names the next
            error and writes nothing.
          </Text>
          <div className="repair__actions">
            <Button role="link" render={<Link params={{ name }} to="/w/$name" />} variant="text">
              Cancel
            </Button>
            <Button aria-busy={saving || undefined} type="submit">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </Card>
    </>
  )
}

/** `/w/$name/repair` (D3 §7.5, ADR-0020): the one surface that edits a
 *  workspace as text. It opens only on a file that will not load, and a save
 *  is refused while the bytes still will not — so a half-finished fix cannot
 *  be kept, which is the cost the ADR names first. */
export function Repair() {
  const { name } = useParams({ from: '/w/$name/repair' })
  const navigate = useNavigate()
  const opened = useQuery(repairQuery(name))
  const save = useRepairWorkspace()

  const heading = (
    <div className="repair__head">
      <Text render={<h1 />} className="repair__title" emphasized scale="display-small">
        Repair {name}
      </Text>
      {opened.data ? <Mono className="repair__path">{opened.data.path}</Mono> : null}
      {opened.data ? (
        <Text className="repair__where" scale="body-small" tone="variant">
          the file as it is on the machine running the daemon
        </Text>
      ) : null}
    </div>
  )

  // A save invalidates this read, and the refetch answers 409 while the
  // mutation is still pending: the editor stays until the navigation.
  if (opened.error && !opened.isFetching && !save.isPending) {
    return (
      <div className="repair">
        {heading}
        <Refused error={opened.error} name={name} reset={() => void opened.refetch()} />
      </div>
    )
  }

  if (!opened.data) {
    return (
      <div aria-busy="true" className="repair" data-slot="reading">
        {heading}
        <Skeleton style={{ height: 120 }} />
        <Skeleton style={{ height: 420 }} />
      </div>
    )
  }

  return (
    <div className="repair">
      {heading}
      <ErrorBoundary layout="card" title="The editor could not be drawn">
        <Editor
          file={opened.data}
          key={opened.data.path}
          name={name}
          onSave={(text) =>
            save.mutate(
              { name, text },
              { onSuccess: () => void navigate({ to: '/w/$name', params: { name } }) },
            )
          }
          refused={save.error}
          saving={save.isPending}
        />
      </ErrorBoundary>
    </div>
  )
}
