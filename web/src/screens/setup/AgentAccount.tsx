import type { ReactNode } from 'react'
import { Copyable } from '@/m3/copyable/Copyable'
import { Text } from '@/m3/text/Text'

function Note(props: { children: ReactNode }) {
  return (
    <Text scale="body-small" tone="variant">
      {props.children}
    </Text>
  )
}

function Linux() {
  return (
    <>
      <Note>As your own admin account, install tmux, git and sshd first, then make karigar and switch to it:</Note>
      <Copyable text="sudo useradd --create-home --shell /bin/bash karigar" what="the command that makes karigar" />
      <Copyable text="sudo usermod -p '*' karigar" what="the command that lets sshd take karigar's key" />
      <Note>karigar then has no password and is not locked, so sshd takes its key.</Note>
      <Copyable text="sudo -iu karigar" what="the command that switches to karigar" />
    </>
  )
}

function Mac() {
  return (
    <>
      <Note>As your admin account, install tmux and git, then make karigar a Standard account; it asks for a password:</Note>
      <Copyable text="brew install tmux git" what="the command that installs tmux and git" />
      <Copyable text="sudo sysadminctl -addUser karigar -fullName Karigar -password -" what="the command that makes karigar" />
      <Note>
        Allow karigar in System Settings → General → Sharing → Remote Login. Then log in as karigar at the Mac's screen
        once: the tmux server and the keychain need its login session. In Terminal there, give its shell Homebrew's PATH:
      </Note>
      <Copyable
        text={`echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile`}
        what="the command that puts Homebrew on the PATH"
      />
      <Note>Open a new Terminal window, run claude and sign in, then run the join command there.</Note>
    </>
  )
}

/** Owner, 2026-11-04 (ADR-0046): agents run as the account that joins, so it
 *  is one without sudo. The join command skips its root steps for it. */
export function AgentAccount(props: { platform: 'linux' | 'macos' }) {
  return (
    <>
      <Note>
        Run the join command as a separate account without sudo, named karigar. Agents run as the account that joins,
        and they must not become root.
      </Note>
      {props.platform === 'linux' ? <Linux /> : <Mac />}
    </>
  )
}
