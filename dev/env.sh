# Source this before running any air tooling.
#   source dev/env.sh
# Adds nvm-managed Node and uv-managed Python to PATH for non-interactive shells.
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  nvm use default >/dev/null 2>&1 || true
fi
export PATH="$HOME/.local/bin:$PATH"
