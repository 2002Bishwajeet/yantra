import { Folder, GitBranch } from 'lucide-react'
import { Card } from '@/m3/card/Card'
import { Segment, Segmented } from '@/m3/segmented/Segmented'
import { Eyebrow, Text } from '@/m3/text/Text'
import type { Provider, Values } from './form'
import { GithubRepos } from './GithubRepos'
import { LocalDirs } from './LocalDirs'
import { SuggestSwitch } from './Suggestion'
import type { SessionForm } from './useSessionForm'

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
      <Segmented
        className="ns__source"
        label="Where the code comes from"
        onValueChange={(value) => choose(value as Provider)}
        value={values.provider}
      >
        <Segment icon={<GitBranch />} value="github">
          GitHub
        </Segment>
        <Segment icon={<Folder />} value="local">
          Local directory
        </Segment>
      </Segmented>
      {values.provider === 'github' ? <GithubRepos form={form} values={values} /> : null}
      {values.provider === 'local' ? <LocalDirs form={form} key={values.machine} values={values} /> : null}
      <SuggestSwitch form={form} values={values} />
      {values.provider === 'local' ? (
        <Text render={<p />} className="ns__note" scale="body-medium" tone="variant">
          Nothing is cloned or written into this folder.
        </Text>
      ) : null}
    </Card>
  )
}
