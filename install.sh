#!/usr/bin/env bash
# Arranque para macOS y Linux.
#
# Se puede usar de dos formas:
#
#   1) Ya clonaste el repo:
#        ./install.sh
#
#   2) Desde cero, en una línea:
#        curl -fsSL https://raw.githubusercontent.com/USUARIO/obsidian-vault-mcp/main/install.sh | bash
#
# Revisa qué falta (git, Node 20+), lo instala con el gestor de paquetes del
# sistema si hace falta, y luego lanza el instalador guiado.

set -euo pipefail

REPO_URL="${OVM_REPO:-https://github.com/USUARIO/obsidian-vault-mcp.git}"
DESTINO="${OVM_DIR:-$HOME/obsidian-vault-mcp}"

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
gris()  { printf '\033[90m%s\033[0m\n' "$1"; }
rojo()  { printf '\033[31m%s\033[0m\n' "$1"; }
neg()   { printf '\033[1m%s\033[0m\n' "$1"; }

echo
neg "  Obsidian MCP — leer tu vault de Obsidian desde el celular"
gris "  Preparando lo que hace falta…"
echo

# ------------------------------------------------------------------ el sistema

SO="$(uname -s)"
case "$SO" in
  Darwin) SISTEMA="mac" ;;
  Linux)  SISTEMA="linux" ;;
  *)      rojo "  ✗ Este script es para macOS y Linux. En Windows usa install.ps1"; exit 1 ;;
esac

# Detecta el gestor de paquetes disponible.
gestor() {
  if [ "$SISTEMA" = "mac" ]; then
    command -v brew >/dev/null 2>&1 && echo brew || echo ninguno
  else
    for g in apt-get dnf pacman zypper apk; do
      command -v "$g" >/dev/null 2>&1 && { echo "$g"; return; }
    done
    echo ninguno
  fi
}

GESTOR="$(gestor)"

instalar_paquete() {
  local nombre="$1"
  case "$GESTOR" in
    brew)     brew install "$nombre" ;;
    apt-get)  sudo apt-get update -qq && sudo apt-get install -y "$nombre" ;;
    dnf)      sudo dnf install -y "$nombre" ;;
    pacman)   sudo pacman -Sy --noconfirm "$nombre" ;;
    zypper)   sudo zypper install -y "$nombre" ;;
    apk)      sudo apk add "$nombre" ;;
    *)        return 1 ;;
  esac
}

# ------------------------------------------------------------------------- git

if command -v git >/dev/null 2>&1; then
  verde "  ✓ git"
else
  gris "  · Falta git. Instalando…"
  if ! instalar_paquete git; then
    rojo "  ✗ No pude instalar git automáticamente."
    if [ "$SISTEMA" = "mac" ]; then
      echo "    Instala las herramientas de línea de comandos con:  xcode-select --install"
      echo "    O instala Homebrew primero:  https://brew.sh"
    fi
    exit 1
  fi
  verde "  ✓ git instalado"
fi

# ------------------------------------------------------------------------ node

necesita_node=1
if command -v node >/dev/null 2>&1; then
  MAYOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAYOR" -ge 20 ] 2>/dev/null; then
    verde "  ✓ Node $(node -v)"
    necesita_node=0
  else
    gris "  · Node $(node -v) es muy viejo (hace falta 20+). Actualizando…"
  fi
else
  gris "  · Falta Node.js. Instalando…"
fi

if [ "$necesita_node" -eq 1 ]; then
  PAQUETE_NODE="nodejs"
  [ "$GESTOR" = "brew" ] && PAQUETE_NODE="node"

  if ! instalar_paquete "$PAQUETE_NODE"; then
    rojo "  ✗ No pude instalar Node.js automáticamente."
    echo
    if [ "$SISTEMA" = "mac" ]; then
      echo "    Opción A — instala Homebrew y vuelve a correr este script:"
      echo "      /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""
      echo
    fi
    echo "    Opción B — descarga el instalador de Node 20 o más nuevo:"
    echo "      https://nodejs.org"
    echo
    exit 1
  fi

  MAYOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  if [ "$MAYOR" -lt 20 ] 2>/dev/null; then
    rojo "  ✗ Quedó Node $(node -v), y hace falta 20 o más nuevo."
    echo "    Bájalo de https://nodejs.org y vuelve a correr este script."
    exit 1
  fi
  verde "  ✓ Node $(node -v) instalado"
fi

# --------------------------------------------------------------- traer el repo

# Si este script vive junto al proyecto, se trabaja ahí mismo.
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"

if [ -n "$AQUI" ] && [ -f "$AQUI/package.json" ] && [ -d "$AQUI/src" ]; then
  PROYECTO="$AQUI"
  verde "  ✓ Proyecto encontrado en $PROYECTO"
elif [ -d "$DESTINO/.git" ]; then
  PROYECTO="$DESTINO"
  gris "  · Ya estaba clonado en $DESTINO. Actualizando…"
  git -C "$DESTINO" pull --ff-only >/dev/null 2>&1 || gris "  · (no pude actualizar; sigo con lo que hay)"
  verde "  ✓ Proyecto listo en $PROYECTO"
else
  if [[ "$REPO_URL" == *"USUARIO"* ]]; then
    rojo "  ✗ No sé de dónde clonar el proyecto."
    echo "    Pásale la dirección del repositorio:"
    echo "      OVM_REPO=https://github.com/tu-usuario/obsidian-vault-mcp.git bash install.sh"
    exit 1
  fi
  gris "  · Clonando en $DESTINO…"
  git clone --depth 1 "$REPO_URL" "$DESTINO"
  PROYECTO="$DESTINO"
  verde "  ✓ Clonado"
fi

# ------------------------------------------------------------------ dependencias

cd "$PROYECTO"

if [ ! -d node_modules ]; then
  gris "  · Instalando dependencias (tarda un par de minutos)…"
  npm install --no-audit --no-fund
  verde "  ✓ Dependencias instaladas"
else
  verde "  ✓ Dependencias ya instaladas"
fi

# ------------------------------------------------------------- instalador guiado

echo
exec node setup/setup.mjs
