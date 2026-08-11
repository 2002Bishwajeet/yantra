/** What [`workspace::validate_name`](../../../crates/yantra-core/src/workspace.rs)
 *  allows, restated rather than inherited: a command someone pastes into a
 *  shell, and a name the form is about to send, must not depend on the daemon's
 *  promise. It was restated twice before D4 put it here.
 *
 *  The daemon's rule is ASCII alphanumeric, `_` and `-`, and not empty. */
export const USABLE_NAME = /^[A-Za-z0-9_-]+$/

/** D4 §4.3: the name follows the directory until a person edits it. From the
 *  repository name in `origin` where the probe found one, because that is what
 *  the project is called — otherwise the directory's own last segment.
 *
 *  Anything the daemon would refuse is dropped rather than sent: a hyphen and
 *  an underscore survive, a space and a dot do not. */
export function derive(path: string, origin: string | null): string {
  const from = origin ? repoOf(origin) : basename(path)
  return from.replace(/[^A-Za-z0-9_-]/g, '')
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] ?? ''
}

// `git@host:owner/repo.git` and `https://host/owner/repo.git` both end the same
// way, so the last segment without its suffix is the whole rule.
function repoOf(origin: string): string {
  return basename(origin).replace(/\.git$/, '')
}
