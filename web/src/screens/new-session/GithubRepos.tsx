import { useDeferredValue, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Check, GitBranch, Search } from 'lucide-react'
import type { Repo } from '@/api'
import { asApiError } from '@/api/errors'
import { useGithub, useGithubReadiness, useHiddenOrgs, useRepos } from '@/api/hooks'
import { dirsQuery } from '@/api/queries'
import { grant, grantPage, hiddenNote, REFUSED } from '@/lib/github'
import { derive } from '@/lib/name'
import { at } from '@/lib/time'
import { Chevron, Control, Icon, Label } from '@/composer/Control'
import { Button } from '@/m3/button/Button'
import { ErrorSurface } from '@/m3/error-surface/ErrorSurface'
import { Menu, MenuLinkItem, MenuPopup, MenuTrigger } from '@/m3/menu/Menu'
import { Row, RowText } from '@/m3/row/Row'
import { Skeleton } from '@/m3/skeleton/Skeleton'
import { Text } from '@/m3/text/Text'
import { TextField } from '@/m3/text-field/TextField'
import { IconTile } from '@/m3/tile/Tile'
import { useTick } from '@/useTick'
import { CloneFolder } from './CloneFolder'
import { rememberCloneFolder, useCloneFolder } from './clonePath'
import type { Values } from './form'
import { byOrigin, filterRepos, place, SHOWN, stateLabel } from './repos'
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

/** The one place the account shows: the chip names the login, the menu holds what it can do.
 *  The grant link always shows, because GitHub cannot name every organisation that hides. A
 *  hidden-org read that did not answer draws no line: the list below it still works. */
function Account(props: { login: string | null; asked: boolean; clientId: string | null }) {
  const hidden = useHiddenOrgs()
  const login = props.login ?? 'signed in'
  const named = hidden.looked === 'ok' && hidden.data.length > 0 ? hidden.data : null
  return (
    <div className="ns__accountrow">
      <Menu>
        <MenuTrigger render={<Control aria-label={`GitHub account: ${login}`} className="ns__account" />}>
          <Icon icon={GitBranch} />
          <Label>{login}</Label>
          <Chevron />
        </MenuTrigger>
        <MenuPopup align="start" aria-label="GitHub account">
          <Text className="ns__status" render={<p />} scale="body-medium" tone="variant">
            {props.asked ? 'Private repositories included' : 'GitHub not asked yet'}
          </Text>
          <MenuLinkItem
            aria-describedby={named ? 'ns-hidden-orgs' : undefined}
            href={grantPage(props.clientId)}
            rel="noreferrer"
            target="_blank"
          >
            Grant access on GitHub
          </MenuLinkItem>
          {named ? (
            <Text className="ns__status" id="ns-hidden-orgs" render={<p />} scale="body-small" tone="variant">
              No repository from {named.join(', ')}
            </Text>
          ) : null}
          <MenuLinkItem render={<Link params={{ category: 'providers' }} to="/settings/$category" />}>
            Use another account
          </MenuLinkItem>
        </MenuPopup>
      </Menu>
      {hidden.looked === 'ok' ? (
        <Text className="ns__one" render={<p title={hiddenNote(hidden.data)} />} scale="body-small" tone="variant">
          {hiddenNote(hidden.data)}
        </Text>
      ) : null}
    </div>
  )
}

function Rows(props: { form: SessionForm; values: Values; repos: Repo[]; query: string }) {
  const { form, values, repos, query } = props
  const machine = values.machine
  const { root, folder, home } = useCloneFolder(machine)
  // One listing of the clone folder answers every row: a repository whose
  // `origin` is already there is already there (the boards' "already on").
  const clones = useQuery({
    ...dirsQuery(machine, folder),
    enabled: folder !== null,
  })
  // A machine with no clone folder yet is not a machine that could not be
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
      {folder !== null ? (
        <CloneFolder
          folder={folder}
          machine={machine}
          onUse={(path) => {
            rememberCloneFolder(machine, path)
            // The chosen repository's path was worked out under the old folder.
            if (values.source?.kind === 'github') form.setFieldValue('source', null)
          }}
          root={root}
        />
      ) : null}
      <ul aria-label="Repositories" className="ns__list">
        {shown.map((repo) => {
          const where = folder === null || clones.isFetching ? null : place(repo, folder, held, because)
          const selected = values.source?.kind === 'github' && values.source.repo.full_name === repo.full_name
          return (
            <li key={repo.full_name}>
              <Row
                aria-pressed={selected}
                className="ns__repo"
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
                <Text className="ns__state" scale="label-medium" tone="variant">
                  {stateLabel(where)}
                </Text>
                {selected ? <Check aria-hidden="true" /> : null}
              </Row>
            </li>
          )
        })}
      </ul>
      {matched.length === 0 ? (
        <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
          nothing matches {query.trim()}
        </Text>
      ) : matched.length > SHOWN ? (
        <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
          {matched.length - SHOWN} more · keep typing to narrow
        </Text>
      ) : null}
    </>
  )
}

/** The GitHub half of step 2: the account chip, the search, and the rows. */
export function GithubRepos(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const github = useGithub()
  const readiness = useGithubReadiness()
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

  const held = grant(github.data, readiness)
  if (held.kind === 'refused') {
    return (
      <ErrorSurface.Inline
        action={
          <Button
            render={<Link params={{ category: 'providers' }} to="/settings/$category" />}
            role="link"
            variant="tonal"
          >
            Sign in again in Settings
          </Button>
        }
        error={{
          kind: 'refused',
          said: readiness.looked === 'ok' ? readiness.data.detail : '',
          retryable: false,
          describe: () => `${REFUSED} — it was revoked or replaced, so no repository can be listed`,
        }}
        title={REFUSED}
      />
    )
  }

  return (
    <div className="ns__github">
      <Account asked={held.kind === 'accepted'} clientId={github.data?.client_id ?? null} login={github.data?.login ?? null} />
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
