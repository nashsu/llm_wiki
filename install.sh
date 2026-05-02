#!/usr/bin/env bash
# llm-wiki-nashsu install script
# Installs the nashsu backend skill (CLI-based, no GUI)

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
PLATFORM="${1:-}"

install_skill_files() {
  local target_dir="$1"
  mkdir -p "$target_dir"
  cp -r "$SKILL_DIR"/* "$target_dir/"
  echo "✅ Skill files installed to $target_dir"
}

install_npm_deps() {
  local skill_dir="${1:-$SKILL_DIR}"
  if [ -d "$skill_dir/skill" ]; then
    echo "📦 Installing Node.js dependencies..."
    cd "$skill_dir/skill"
    npm install --quiet
    echo "✅ Dependencies installed"
  fi
}

echo "🔧 llm-wiki-nashsu Skill Installer"
echo "   Source: $SKILL_DIR"
echo ""

case "$PLATFORM" in
  --platform=hermes|--platform\ hermes)
    HERMES_SKILLS="${HOME}/.hermes/skills"
    TARGET="${HERMES_SKILLS}/llm-wiki-nashsu"
    echo "🎯 Platform: Hermes"
    install_skill_files "$TARGET"
    install_npm_deps "$TARGET"
    echo ""
    echo "✅ Installed to: $TARGET"
    echo "   Usage: hermes run llm-wiki-nashsu graph <wiki_root>"
    ;;

  --platform=claude|--platform\ claude)
    echo "🎯 Platform: Claude Code"
    echo "   Add to CLAUDE.md:"
    echo "   @${SKILL_DIR}/SKILL.md"
    install_npm_deps
    ;;

  "")
    echo "📦 Local installation (no platform)"
    install_npm_deps
    echo ""
    echo "✅ Ready. Usage:"
    echo "   node ${SKILL_DIR}/skill/src/cli.ts graph <wiki_root>"
    ;;

  *)
    echo "⚠️  Unknown platform: $PLATFORM"
    echo "   Supported: --platform hermes, --platform claude"
    exit 1
    ;;
esac
