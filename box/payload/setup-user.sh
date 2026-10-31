#!/bin/bash
# Runs as the login user. Only Claude Code may stop the boot; the dotfiles hook is reported.
set -uo pipefail
cd
export PATH="$HOME/.local/bin:$PATH"

tar -xzf "$1"
mkdir -p "$HOME/.local/bin"
curl -fsSL https://claude.ai/install.sh | bash || exit 1

if [ -f "$HOME/.yantra-box/setup.sh" ]; then
    bash "$HOME/.yantra-box/setup.sh" || echo 'yantra-box: FAILED: .yantra-box/setup.sh'
fi
exit 0
