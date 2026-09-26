#!/usr/bin/env bash
# ContextForge: Game Factory Workbench Launcher Script
# Starts the GUI launcher or boots the server and opens the browser.

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
cd "$DIR"

# Ensure ~/.local/node/bin is in PATH if node is installed there
if [ -d "$HOME/.local/node/bin" ]; then
    export PATH="$HOME/.local/node/bin:$PATH"
fi

# If python3-tk is present and display is available, start the GUI launcher
if command -v python3 >/dev/null 2>&1 && python3 -c "import tkinter" >/dev/null 2>&1 && [ -n "$DISPLAY" -o -n "$WAYLAND_DISPLAY" ]; then
    python3 "$DIR/launcher.py" "$@"
else
    # Fallback CLI runner: Start node server and open browser
    echo "Starting ContextForge Server on http://localhost:3000..."
    if command -v xdg-open >/dev/null 2>&1; then
        (sleep 1.5 && xdg-open "http://localhost:3000/") &
    fi
    node server/index.js
fi
