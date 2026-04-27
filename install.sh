#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────
#  Asterisk — local-first AI agent CLI
#  Install script for macOS and Linux
#  Usage: curl -fsSL https://raw.githubusercontent.com/ayvazyan10/asterisk/master/install.sh | bash
# ─────────────────────────────────────────────

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
CYAN="\033[36m"
RED="\033[31m"
YELLOW="\033[33m"
RESET="\033[0m"

REPO_URL="${ASTERISK_REPO_URL:-https://github.com/ayvazyan10/asterisk.git}"
INSTALL_DIR="${ASTERISK_INSTALL_DIR:-$HOME/.local/share/asterisk}"
BIN_DIR="${ASTERISK_BIN_DIR:-$HOME/.local/bin}"
BRANCH="${ASTERISK_BRANCH:-master}"

echo ""
echo -e "${BOLD}  ✱  Asterisk — local-first AI agent CLI${RESET}"
echo -e "${DIM}  https://github.com/ayvazyan10/asterisk${RESET}"
echo ""

step() { echo -e "${CYAN}  →${RESET} $1"; }
ok()   { echo -e "${GREEN}  ✓${RESET} $1"; }
warn() { echo -e "${YELLOW}  !${RESET} $1"; }
fail() { echo -e "${RED}  ✗${RESET} $1" >&2; exit 1; }

# ── Check git ──────────────────────────────
step "Checking git..."
if ! command -v git &>/dev/null; then
  fail "git not found. Install git from https://git-scm.com"
fi
ok "git $(git --version | cut -d' ' -f3)"

# ── Check / install Bun ────────────────────
step "Checking Bun..."
if ! command -v bun &>/dev/null; then
  step "Bun not found — installing from https://bun.sh ..."
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    || fail "Could not install Bun automatically. Install manually from https://bun.sh and re-run this script."
  # Bun's installer adds itself to ~/.bun/bin
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun &>/dev/null; then
    fail "Bun installed but not on PATH. Restart your shell and re-run."
  fi
fi
BUN_VER=$(bun --version 2>/dev/null || echo "unknown")
ok "Bun $BUN_VER"

# ── Clone or update source ─────────────────
step "Fetching Asterisk source into ${INSTALL_DIR}..."
mkdir -p "$(dirname "$INSTALL_DIR")"
if [[ -d "$INSTALL_DIR/.git" ]]; then
  git -C "$INSTALL_DIR" fetch --tags origin "$BRANCH" >/dev/null 2>&1 \
    || fail "git fetch failed inside $INSTALL_DIR"
  git -C "$INSTALL_DIR" checkout -q "$BRANCH"
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH" >/dev/null
  ok "updated existing checkout"
else
  if [[ -e "$INSTALL_DIR" ]]; then
    fail "$INSTALL_DIR exists and is not a git repo. Remove it or set ASTERISK_INSTALL_DIR."
  fi
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" >/dev/null 2>&1 \
    || fail "git clone failed: $REPO_URL"
  ok "cloned $REPO_URL"
fi

# ── Install dependencies ───────────────────
step "Installing dependencies (this can take a minute)..."
( cd "$INSTALL_DIR" && bun install --silent >/dev/null 2>&1 ) \
  || fail "bun install failed in $INSTALL_DIR"
ok "dependencies installed"

# ── Build distributable ────────────────────
step "Building..."
( cd "$INSTALL_DIR" && bun run build >/dev/null 2>&1 ) \
  || fail "bun run build failed"
ok "built dist/"

# ── Symlink onto PATH ──────────────────────
step "Linking ${BIN_DIR}/asterisk → ${INSTALL_DIR}/bin/asterisk"
mkdir -p "$BIN_DIR"
ln -sf "$INSTALL_DIR/bin/asterisk" "$BIN_DIR/asterisk"
chmod +x "$INSTALL_DIR/bin/asterisk"
ok "symlink in place"

# ── PATH check ─────────────────────────────
case ":$PATH:" in
  *":$BIN_DIR:"*) PATH_OK=1 ;;
  *) PATH_OK=0 ;;
esac

if [[ "$PATH_OK" -eq 0 ]]; then
  warn "$BIN_DIR is not on your PATH."
  echo -e "${DIM}    Add this to your shell rc (~/.bashrc, ~/.zshrc, etc.):${RESET}"
  echo -e "${DIM}        export PATH=\"$BIN_DIR:\$PATH\"${RESET}"
  echo -e "${DIM}    Then restart your shell or \`source\` the rc file.${RESET}"
fi

echo ""
echo -e "${BOLD}${GREEN}  Asterisk installed.${RESET}"
echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo -e "    ${CYAN}asterisk configure${RESET}    ${DIM}# interactive wizard for provider + bots${RESET}"
echo -e "    ${CYAN}asterisk${RESET}              ${DIM}# launch the REPL${RESET}"
echo -e "    ${CYAN}asterisk start${RESET}        ${DIM}# run as daemon (Telegram/WhatsApp bridges)${RESET}"
echo -e "    ${CYAN}asterisk help${RESET}         ${DIM}# full subcommand list${RESET}"
echo ""
echo -e "  ${DIM}Source:  $INSTALL_DIR${RESET}"
echo -e "  ${DIM}Config:  ~/.asterisk/${RESET}"
echo ""

if [[ "$PATH_OK" -eq 0 ]]; then
  echo -e "  ${YELLOW}For this shell only:${RESET} export PATH=\"$BIN_DIR:\$PATH\""
  echo ""
fi
