import type { ReactNode } from 'react'
import { Folder, GitBranch } from 'lucide-react'
import { Eyebrow, Text } from '@/m3/text/Text'
import { Card } from '@/m3/card/Card'
import type { Provider, Values } from './form'
import { GithubRepos } from './GithubRepos'
import { LocalDirs } from './LocalDirs'
import type { SessionForm } from './useSessionForm'

function Choice(props: {
  icon: ReactNode
  title: string
  note: string
  pressed: boolean
  disabled?: boolean
  onPress: () => void
}) {
  const { icon, title, note, pressed, disabled, onPress } = props
  return (
    <button
      aria-pressed={pressed}
      className="ns__choice m3-interactive"
      disabled={disabled}
      onClick={onPress}
      type="button"
    >
      <span aria-hidden="true" className="ns__choice-icon">
        {icon}
      </span>
      <span className="ns__choice-text">
        <Text emphasized scale="title-medium">
          {title}
        </Text>
        <Text scale="body-small" tone="variant">
          {note}
        </Text>
      </span>
    </button>
  )
}

/** Step 2: where the code comes from (NewSessionSource, NewSessionLocal). */
export function StepSource(props: { form: SessionForm; values: Values }) {
  const { form, values } = props
  const choose = (provider: Provider) => {
    if (provider === values.provider) return
    form.setFieldValue('provider', provider)
    form.setFieldValue('source', null)
  }
  return (
    <Card className="ns__card">
      <Eyebrow render={<h2 />}>Where the code comes from</Eyebrow>
      <div aria-label="Where the code comes from" className="ns__choices" role="group">
        <Choice
          icon={<GitBranch />}
          note="your repositories, private ones included"
          onPress={() => choose('github')}
          pressed={values.provider === 'github'}
          title="GitHub"
        />
        <Choice
          disabled
          icon={<GitBranch />}
          note="later"
          onPress={() => choose('gitlab')}
          pressed={values.provider === 'gitlab'}
          title="GitLab"
        />
        <Choice
          icon={<Folder />}
          note="pick or make any folder on the machine"
          onPress={() => choose('local')}
          pressed={values.provider === 'local'}
          title="Local directory"
        />
      </div>
      {values.provider === 'github' ? <GithubRepos form={form} values={values} /> : null}
      {values.provider === 'local' ? <LocalDirs form={form} values={values} /> : null}
      <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
        {values.provider === 'local'
          ? `the session's working directory is this folder on ${values.machine}. Nothing is cloned and nothing is written into it.`
          : 'a repository that is not on the machine is cloned under ~/Github, after the provider it came from. Local directory lets you pick or make any folder instead.'}
      </Text>
    </Card>
  )
}
