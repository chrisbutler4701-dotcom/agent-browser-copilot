#!/usr/bin/env bash
set -e

# ==============================================================================
# Agent Browser Copilot — 1-Command Universal Installer
# Compatible with macOS, Ubuntu, Debian, CentOS, Fedora
# ==============================================================================

REPO_URL="https://github.com/chrisbutler4701-dotcom/agent-browser-copilot.git"
INSTALL_DIR="${HOME}/agent-browser-copilot"

BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
RESET='\033[0m'

echo -e "\n${BOLD}${CYAN}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║             AGENT BROWSER COPILOT                     ║"
echo "  ║    Empower your AI agent with real browser control    ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${RESET}\n"

# 1. Check Node.js
echo -e "${CYAN}==> Checking runtime dependencies...${RESET}"
if ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}✖ Node.js is not installed.${RESET}"
    echo "Please install Node.js 18 or newer (https://nodejs.org) and rerun this installer."
    exit 1
fi

NODE_MAJOR=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "${RED}✖ Node.js version $(node -v) is too old. Node 18 or newer required.${RESET}"
    exit 1
fi
echo -e "${GREEN}✔ Node.js $(node -v) detected.${RESET}"

# 2. Check Git
if ! command -v git >/dev/null 2>&1; then
    echo -e "${RED}✖ Git is required but not installed.${RESET}"
    exit 1
fi

# 3. Clone or Update
if [ -d "$INSTALL_DIR" ]; then
    echo -e "${YELLOW}==> Existing installation found in $INSTALL_DIR. Updating...${RESET}"
    cd "$INSTALL_DIR"
    git pull || true
else
    echo -e "${CYAN}==> Cloning Agent Browser Copilot into $INSTALL_DIR...${RESET}"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
fi

# 4. Install Dependencies
echo -e "${CYAN}==> Installing package dependencies...${RESET}"
npm install --silent

# 5. Link Global Binary
echo -e "${CYAN}==> Linking 'copilot' command...${RESET}"
chmod +x ./bin/copilot ./bin/doctor.js ./setup.js
if [ -w /usr/local/bin ]; then
    ln -sf "$INSTALL_DIR/bin/copilot" /usr/local/bin/copilot
    echo -e "${GREEN}✔ Installed /usr/local/bin/copilot${RESET}"
elif [ -d "$HOME/.local/bin" ]; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$INSTALL_DIR/bin/copilot" "$HOME/.local/bin/copilot"
    echo -e "${GREEN}✔ Installed ~/.local/bin/copilot${RESET}"
fi

# 6. Run Interactive Setup Wizard
echo -e "\n${BOLD}${GREEN}==> Launching Setup Wizard...${RESET}\n"
node setup.js

# 7. Run Health Doctor
echo -e "\n${BOLD}${CYAN}==> Running Copilot Doctor...${RESET}\n"
node bin/doctor.js || true

echo -e "\n${BOLD}${GREEN}======================================================${RESET}"
echo -e "${BOLD}${GREEN}🎉 INSTALLATION SUCCESSFUL!${RESET}"
echo -e "${BOLD}${GREEN}======================================================${RESET}"
echo -e "\nQuick Commands:"
echo -e "  ${BOLD}copilot start${RESET}    - Start broker daemon & bot"
echo -e "  ${BOLD}copilot status${RESET}   - Check connection & active tab"
echo -e "  ${BOLD}copilot doctor${RESET}   - Run health checks"
echo -e "\nChrome Extension Location:"
echo -e "  📁 ${BOLD}$INSTALL_DIR/extension${RESET}"
echo -e "  Load unpacked in ${CYAN}chrome://extensions/${RESET}\n"
