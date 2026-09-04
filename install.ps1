# Arranque para Windows (PowerShell 5.1 o más nuevo).
#
# Se puede usar de dos formas:
#
#   1) Ya clonaste el repo:
#        .\install.ps1
#
#   2) Desde cero, en una línea:
#        irm https://raw.githubusercontent.com/prcontreras23/obsidian-vault-mcp/main/install.ps1 | iex
#
# Revisa qué falta (git, Node 20+), lo instala con winget o Chocolatey si hace
# falta, y luego lanza el instalador guiado.
#
# Si PowerShell se queja de que no puede ejecutar scripts, corre antes:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass

$ErrorActionPreference = 'Stop'

function Verde($m) { Write-Host "  $m" -ForegroundColor Green }
function Gris($m)  { Write-Host "  $m" -ForegroundColor DarkGray }
function Rojo($m)  { Write-Host "  $m" -ForegroundColor Red }
function Neg($m)   { Write-Host "  $m" -ForegroundColor White }

$RepoUrl = if ($env:OVM_REPO) { $env:OVM_REPO } else { 'https://github.com/prcontreras23/obsidian-vault-mcp.git' }
$Destino = if ($env:OVM_DIR)  { $env:OVM_DIR }  else { Join-Path $HOME 'obsidian-vault-mcp' }

Write-Host ''
Neg 'Obsidian MCP — leer tu vault de Obsidian desde el celular'
Gris 'Preparando lo que hace falta…'
Write-Host ''

function Existe($cmd) { $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue) }

# Refresca el PATH de esta sesión: tras instalar algo, el comando nuevo no
# aparece hasta que se relee, y no queremos obligar a reabrir la terminal.
function RefrescarPath {
  $maquina = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $usuario = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = "$maquina;$usuario"
}

function Instalar($wingetId, $chocoId, $nombre) {
  if (Existe 'winget') {
    Gris "· Instalando $nombre con winget…"
    winget install --id $wingetId --accept-source-agreements --accept-package-agreements --silent
    RefrescarPath
    return $true
  }
  if (Existe 'choco') {
    Gris "· Instalando $nombre con Chocolatey…"
    choco install $chocoId -y
    RefrescarPath
    return $true
  }
  return $false
}

# ------------------------------------------------------------------------- git

if (Existe 'git') {
  Verde "✓ git"
} else {
  if (-not (Instalar 'Git.Git' 'git' 'git')) {
    Rojo '✗ No pude instalar git automáticamente.'
    Write-Host '    Descárgalo de https://git-scm.com/download/win y vuelve a correr este script.'
    exit 1
  }
  if (-not (Existe 'git')) {
    Rojo '✗ git se instaló pero no aparece en el PATH.'
    Write-Host '    Cierra esta terminal, abre una nueva y vuelve a correr el script.'
    exit 1
  }
  Verde '✓ git instalado'
}

# ------------------------------------------------------------------------ node

$necesitaNode = $true
if (Existe 'node') {
  $mayor = [int](node -p 'process.versions.node.split(".")[0]')
  if ($mayor -ge 20) {
    Verde "✓ Node $(node -v)"
    $necesitaNode = $false
  } else {
    Gris "· Node $(node -v) es muy viejo (hace falta 20+). Actualizando…"
  }
} else {
  Gris '· Falta Node.js. Instalando…'
}

if ($necesitaNode) {
  if (-not (Instalar 'OpenJS.NodeJS.LTS' 'nodejs-lts' 'Node.js')) {
    Rojo '✗ No pude instalar Node.js automáticamente.'
    Write-Host ''
    Write-Host '    No hay winget ni Chocolatey en esta computadora.'
    Write-Host '    Descarga Node 20 o más nuevo de https://nodejs.org y vuelve a correr el script.'
    Write-Host ''
    exit 1
  }
  if (-not (Existe 'node')) {
    Rojo '✗ Node se instaló pero no aparece en el PATH.'
    Write-Host '    Cierra esta terminal, abre una nueva y vuelve a correr el script.'
    exit 1
  }
  $mayor = [int](node -p 'process.versions.node.split(".")[0]')
  if ($mayor -lt 20) {
    Rojo "✗ Quedó Node $(node -v), y hace falta 20 o más nuevo."
    exit 1
  }
  Verde "✓ Node $(node -v) instalado"
}

# --------------------------------------------------------------- traer el repo

# Si el script se corrió desde el propio proyecto, se trabaja ahí mismo.
$aqui = if ($PSScriptRoot) { $PSScriptRoot } else { $null }

if ($aqui -and (Test-Path (Join-Path $aqui 'package.json')) -and (Test-Path (Join-Path $aqui 'src'))) {
  $Proyecto = $aqui
  Verde "✓ Proyecto encontrado en $Proyecto"
} elseif (Test-Path (Join-Path $Destino '.git')) {
  $Proyecto = $Destino
  Gris "· Ya estaba clonado en $Destino. Actualizando…"
  git -C $Destino pull --ff-only 2>$null | Out-Null
  Verde "✓ Proyecto listo en $Proyecto"
} else {
  if ($RepoUrl -like '*USUARIO*') {
    Rojo '✗ No sé de dónde clonar el proyecto.'
    Write-Host '    Pásale la dirección del repositorio:'
    Write-Host '      $env:OVM_REPO="https://github.com/tu-usuario/obsidian-vault-mcp.git"; .\install.ps1'
    exit 1
  }
  Gris "· Clonando en $Destino…"
  git clone --depth 1 $RepoUrl $Destino
  $Proyecto = $Destino
  Verde '✓ Clonado'
}

# ------------------------------------------------------------------ dependencias

Set-Location $Proyecto

if (-not (Test-Path 'node_modules')) {
  Gris '· Instalando dependencias (tarda un par de minutos)…'
  npm install --no-audit --no-fund
  Verde '✓ Dependencias instaladas'
} else {
  Verde '✓ Dependencias ya instaladas'
}

# ------------------------------------------------------------- instalador guiado

Write-Host ''
node setup/setup.mjs
exit $LASTEXITCODE
