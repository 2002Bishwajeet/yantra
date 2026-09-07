import { useDeferredValue, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { GitBranch, Search } from 'lucide-react'
import type { Repo } from '@/api'
import { asApiError } from '@/api/errors'
import { useGithub, useRepos } from '@/api/hooks'
import { dirsQuery } from '@/api/queries'
import { derive } from '@/lib/name'
import { trimSlash } from '@/lib/path'
import { at } from '@/lib/time'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Mono, Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { IconTile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import { cloneHome, tilde, type Values } from './form'
import { byOrigin, filterRepos, place, SHOWN } from './repos'
import type { SessionForm } from './useSessionForm'

function pushed(repo: Repo, now: number): string {
  if (repo.pushed_at === null) return 'never pushed'
  const read = at(repo.pushed_at, now)
  if (!read) return `pushed ${repo.pushed_at}`
  return /^\d+[smh]$/.test(read.text) ? `pushed ${read.text} ago` : `pushed ${read.text}`
}

const notSignedIn = {
  kind: 'refused' as const,
  said: '',
  retryable: false,
  describe: () => 'Nothing is signed in to Yantra, so no repository can be listed.',
}

function SignedIn(props: { login: string | null }) {
  return (
    <p className="ns__signed">
      <Text scale="body-medium" tone="variant">
        github.com · {props.login ?? 'signed in'} · signed in to Yantra · private repositories included
      </Text>
      <Link className="ns__link" params={{ category: 'providers' }} to="/settings/$category">
        Use another account
      </Link>
    </p>
  )
}

function Rows(props: { form: SessionForm; values: Values; repos: Repo[]; query: string }) {
  const { form, values, repos, query } = props
  const machine = values.machine
  const home = useQuery({ ...dirsQuery(machine, null), enabled: true })
  const root = home.data ? trimSlash(home.data.path) : null
  // One listing of the clone home answers every row: a repository whose
  // `origin` is already there is already there (the boards' "already on").
  const clones = useQuery({
    ...dirsQuery(machine, root === null ? null : cloneHome(root)),
    enabled: root !== null,
  })
  // A machine with no clone home yet is not a machine that could not be
  // asked: `dirs` answers 409 for a path that is not a directory.
  const missing = clones.error !== null && asApiError(clones.error).status === 409
  const because = clones.error && !missing ? asApiError(clones.error).said : undefined
  const held = byOrigin(clones.data)
  const matched = filterRepos(repos, query)
  const shown = matched.slice(0, SHOWN)
  const now = useTick(false)

  if (home.error) {
    return (
      <ErrorSurface.Inline
        error={asApiError(home.error)}
        reset={() => void home.refetch()}
        title={`${machine} could not be asked where its home is, so no repository can be placed on it`}
        action={
          <Button onClick={() => void home.refetch()} variant="text">
            Ask again
          </Button>
        }
      />
    )
  }

  return (
    <>
      <ul aria-label="Repositories" className="ns__list">
        {shown.map((repo) => {
          const where = root === null || clones.isFetching ? null : place(repo, root, held, because)
          const selected = values.source?.kind === 'github' && values.source.repo.full_name === repo.full_name
          const said =
            where === null
              ? 'checking…'
              : where.here === 'yes'
                ? `already on ${machine} at ${tilde(where.path, root)}`
                : where.here === 'no'
                  ? `not here yet · clone into ${tilde(where.path, root)}`
                  : `${machine} could not be asked · clone into ${tilde(where.path, root)}`
          return (
            <li key={repo.full_name}>
              <Row
                aria-pressed={selected}
                render={<button disabled={where === null} type="button" />}
                onClick={() => {
                  if (where === null) return
                  form.setFieldValue('source', { kind: 'github', repo, ...where })
                  if (!values.named) form.setFieldValue('name', derive(where.path, repo.clone_url))
                }}
                tone={selected ? 'selected' : 'lowest'}
              >
                <IconTile>
                  <GitBranch />
                </IconTile>
                <RowText
                  headline={repo.full_name}
                  supporting={`${repo.private ? 'private' : 'public'}${repo.language ? ` · ${repo.language}` : ''} · ${pushed(repo, now)}`}
                />
                <Mono className="ns__place">{said}</Mono>
              </Row>
            </li>
          )
        })}
      </ul>
      {matched.length === 0 ? (
        <Text as="p" className="ns__note" scale="body-medium" tone="variant">
          nothing matches {query.trim()}
        </Text>
      ) : matched.length > SHOWN ? (
        <Text as="p" className="ns__note" scale="body-medium" tone="variant">
          {matched.length - SHOWN} more · keep typing to narrow
        </Text>
      ) : null}
    </>
  )
}

/** The GitHub half of step 2: the signed-in line, the search, and the rows. */
export function GithubRepos(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const github = useGithub()
  const repos = useRepos()
  const [query, setQuery] = useState('')
  const deferred = useDeferredValue(query)

  if (github.error) {
    return <ErrorSurface.Inline error={asApiError(github.error)} reset={() => void github.refetch()} title="GitHub" />
  }
  if (github.data && !github.data.connected) {
    return (
      <ErrorSurface.Inline
        action={
          <Button
            render={<Link params={{ category: 'providers' }} to="/settings/$category" />}
            role="link"
            variant="tonal"
          >
            Sign in in Settings
          </Button>
        }
        error={notSignedIn}
        title="GitHub is not signed in"
      />
    )
  }

  return (
    <div className="ns__github">
      <SignedIn login={github.data?.login ?? null} />
      <TextField
        autoComplete="off"
        label="Search your repositories"
        leading={<Search />}
        onValueChange={setQuery}
        value={query}
      />
      {repos.looked === 'pending' ? (
        <div aria-busy="true" className="ns__list">
          <Skeleton />
          <Skeleton />
          <Skeleton />
        </div>
      ) : repos.looked === 'ok' ? (
        <Rows form={form} query={deferred} repos={repos.data} values={values} />
      ) : (
        <ErrorSurface.Inline
          error={{
            kind: 'network',
            said: repos.looked === 'failed' ? repos.error : '',
            retryable: false,
            describe: () =>
              repos.looked === 'never'
                ? 'The daemon has not read the repositories yet.'
                : 'The repositories could not be read.',
          }}
          title="Repositories"
        />
      )}
    </div>
  )
}
