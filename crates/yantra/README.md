# yantra

The command-line client. Ask for a workspace and it restores the context — picks the machine, opens
the tmux session, resumes the agent.

```sh
yantra up nexus --agent claude   # open it, and start Claude Code in it
yantra logs nexus                # what the agent has been saying
yantra status nexus              # running? finished? crashed?
yantra down nexus                # stop it, cleanly

yantra ls machines               # the tailnet
yantra ls sessions               # what is running, everywhere
yantra fix-terminfo <machine>    # teach a machine your terminal
```

Workspaces are TOML files in `~/.config/yantra/workspaces/<name>.toml`:

```toml
machine = "bishwajeets-macbook-pro"   # an ssh destination — ~/.ssh/config decides what it means
repo    = "/Users/you/code/nexus"     # the path on *that* machine
startup = "just dev"                  # optional; conflicts with --agent
```

The CLI does no orchestration of its own — it renders results and picks exit codes, and everything
else lives in [`yantra-core`](../yantra-core/README.md). Exit codes are documented in
[CLAUDE.md](CLAUDE.md) and are worth reading before scripting against them.

See [docs/development.md](../../docs/development.md) for local setup.
