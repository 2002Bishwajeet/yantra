# Yantra box

`build.sh` makes a USB installer. It turns a spare x86-64 computer into a Yantra appliance with no
desktop: Debian 13, Tailscale, the daemon, Claude Code, and a terminal home screen.

**The installer erases the computer's internal disk.** It waits for you to press Enter first.

## Build the stick

You need Linux, podman, curl and openssl.

```sh
./build.sh ~/.ssh/id_ed25519.pub
./flash.sh /dev/sdX
```

`build.sh` asks for the account password and a Tailscale auth key. The key is optional. With no key,
first boot waits for you to open a login link.

| Setting | Default | Meaning |
| --- | --- | --- |
| `BOX_USER` | `yantra-owner` | The login account |
| `BOX_HOSTNAME` | `yantra-box` | The machine name |
| `BOX_TZ` | `UTC` | The time zone |

A second argument names a folder of dotfiles to copy into the login account's home. If that folder
holds `.yantra-box/setup.sh`, first boot runs it as the login user.

**Treat the stick as a secret until you erase it.** It holds the password hash and the auth key.

## After first boot

1. Log in with `ssh yantra-box`.
2. Choose Shell, then run `claude` and `gh auth login`.
3. Turn off key expiry for the machine in Tailscale.

## The home screen

An existing box can take the screen without a reinstall:

```sh
sudo bash ui/install.sh <login-user>
```

It uses [Zellij](https://github.com/zellij-org/zellij), [WTF](https://github.com/wtfutil/wtf),
[systemctl-tui](https://github.com/rgwood/systemctl-tui), btop and gum. Agents stay in tmux.
`F1`, `F2` and `F3` open the tabs. The menu's Shell leaves the screen, and it returns at the next login.

`/etc/os-release` keeps `ID=debian`, so `apt` still works. The firmware logo stays.

## A custom name

`domain-setup.sh` serves the dashboard on your own domain to tailnet devices only.
