import { Link } from '@/components/Link'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { useRoute } from '@/router'
import { Fleet } from '@/routes/Fleet'
import { OneMachine } from '@/routes/OneMachine'
import { OneWorkspace } from '@/routes/OneWorkspace'

export default function App() {
  const route = useRoute()

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 p-6">
      <h1 className="font-heading text-2xl font-semibold">
        <Link to="/">Yantra</Link>
      </h1>

      {route.at === 'fleet' && <Fleet />}
      {/* Keyed on the name: a different machine is a different set of readings,
          and the same is true of a workspace's socket (Y-130). */}
      {route.at === 'machine' && (
        <OneMachine key={route.machine} machine={route.machine} />
      )}
      {route.at === 'workspace' && (
        <OneWorkspace key={route.name} name={route.name} />
      )}
      {route.at === 'nowhere' && (
        <Alert variant="destructive">
          <AlertTitle>Nothing is at {route.path}.</AlertTitle>
          <AlertDescription>
            <Link to="/">The fleet</Link> is where the machines and workspaces
            are.
          </AlertDescription>
        </Alert>
      )}
    </main>
  )
}
