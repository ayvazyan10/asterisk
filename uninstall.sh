#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  Asterisk — uninstaller
#  Usage: bash <(curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/uninstall.sh)
# ─────────────────────────────────────────────

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RESET="\033[0m"

INSTALL_DIR="${ASTERISK_INSTALL_DIR:-$HOME/.local/share/asterisk}"
BIN_DIR="${ASTERISK_BIN_DIR:-$HOME/.local/bin}"
CONFIG_DIR="${ASTERISK_HOME:-$HOME/.asterisk}"

echo ""
echo -e "${BOLD}  ✱  Asterisk uninstaller${RESET}"
echo ""

# Stop daemon if it's running.
if [[ -x "$INSTALL_DIR/bin/asterisk" ]]; then
  echo -e "${CYAN}  →${RESET} Stopping daemon (if running)..."
  "$INSTALL_DIR/bin/asterisk" stop >/dev/null 2>&1 || true
fi

# Remove symlink.
if [[ -L "$BIN_DIR/asterisk" ]]; then
  rm -f "$BIN_DIR/asterisk"
  echo -e "${GREEN}  ✓${RESET} removed $BIN_DIR/asterisk"
fi

# Remove install dir.
if [[ -d "$INSTALL_DIR" ]]; then
  rm -rf "$INSTALL_DIR"
  echo -e "${GREEN}  ✓${RESET} removed $INSTALL_DIR"
fi

# Config dir is preserved by default (contains user data + secrets).
if [[ -d "$CONFIG_DIR" ]]; then
  echo -e "${YELLOW}  !${RESET} Kept $CONFIG_DIR (contains your config + secrets)."
  echo -e "${DIM}    To remove it as well: rm -rf $CONFIG_DIR${RESET}"
fi

echo ""
echo -e "${BOLD}${GREEN}  Asterisk uninstalled.${RESET}"
echo ""
