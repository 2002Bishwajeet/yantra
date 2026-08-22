# yantra

The command-line client. Ask for a workspace and it restores the context — picks the machine, opens
the tmux session, resumes the agent.

```sh
yantra new site --machine mac --repo /Users/you/code/site   # write a workspace
yantra edit site --repo /Users/you/code/website             # change one that exists

yantra up yantra --agent claude  # open it, and start Claude Code in it
yantra resume yantra             # start it again where the last conversation stopped
yantra logs yantra               # what the agent has been saying
yantra status yantra             # running? finished? crashed?
yantra tokens yantra             # what the session has spent, in tokens and dollars
yantra down yantra               # stop it, cleanly
yantra rm yantra [--force]       # delete the workspace, refusing while its session is open
yantra kill mac scratch          # stop any session by machine and name
yantra probe mac /code/site      # is it there, and what origin does it hold?

yantra ls machines               # the tailnet
yantra ls workspaces             # what you have defined
yantra ls sessions               # what is running, everywhere
yantra ls attention              # issues, reviews and notifications waiting on GitHub
yantra notify 'needs you'        # publish to the relay YANTRA_NTFY_URL names
yantra relay <url> [--token T]   # write that relay down for yantrad, and test it
yantra doctor [machine] [--json] # what each machine can and cannot do; changes nothing
yantra fix-terminfo <machine>    # teach a machine your terminal
yantra ssh-identity              # prepare this account's ~/.ssh, and print the key to place
```

Workspaces are TOML files in `~/.config/yantra/workspaces/<name>.toml`:

```toml
machine = "bishwajeets-macbook-pro"   # an ssh destination — ~/.ssh/config decides what it means
repo    = "/Users/you/code/yantra"    # the path on *that* machine
startup = "just dev"                  # optional; conflicts with --agent
```

The CLI does no orchestration of its own — it renders results and picks exit codes, and everything
else lives in [`yantra-core`](../yantra-core/README.md). Exit codes are documented in
[CLAUDE.md](CLAUDE.md) and are worth reading before scripting against them.

See [docs/development.md](../../docs/development.md) for local setup, [tracker.md](tracker.md) for
what binds this crate, and [../../tracker.md](../../tracker.md) for project state.
