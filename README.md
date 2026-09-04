# Obsidian MCP

Lee tu vault de Obsidian desde el celular, preguntándole a Claude.

Levanta un servidor MCP en Cloudflare con una copia de tus notas, y tu
computadora le sube los cambios cada cierto tiempo. Como la copia vive en la
nube, funciona aunque la computadora esté dormida o apagada — que es justo
cuando uno necesita buscar algo desde el teléfono.

- **Solo lectura.** Nada de lo que hagas desde el celular escribe en el vault.
  El flujo es de un solo sentido: vault → nube.
- **Búsqueda de verdad.** Índice de texto completo con ranking BM25, insensible
  a tildes: «oracion» encuentra «oración».
- **Entiende tu frontmatter, sea cual sea.** No trae campos predefinidos: lee
  los que tus notas ya usan y te deja filtrar por ellos.
- **Con contraseña.** OAuth 2.1 con PKCE. Escribes la contraseña una vez en el
  celular al conectar, y ya.
- **Gratis en la práctica.** Cabe de sobra en el plan gratuito de Cloudflare
  (100 000 peticiones al día; un vault de 1 000 notas ocupa ~7 MB de 5 GB).

Solo sube los `.md`. Las imágenes, PDF y audios se quedan en tu computadora.

---

## Instalación

Hace falta **Node 20 o más nuevo** y una **cuenta de Cloudflare** (la gratuita
sirve). Si no tienes Node, los scripts de abajo lo instalan.

### macOS y Linux

```bash
git clone https://github.com/USUARIO/obsidian-vault-mcp.git ~/obsidian-vault-mcp
cd ~/obsidian-vault-mcp
./install.sh
```

O en una línea, sin clonar antes:

```bash
curl -fsSL https://raw.githubusercontent.com/USUARIO/obsidian-vault-mcp/main/install.sh | bash
```

### Windows

En PowerShell:

```powershell
git clone https://github.com/USUARIO/obsidian-vault-mcp.git $HOME\obsidian-vault-mcp
cd $HOME\obsidian-vault-mcp
.\install.ps1
```

O en una línea:

```powershell
irm https://raw.githubusercontent.com/USUARIO/obsidian-vault-mcp/main/install.ps1 | iex
```

Si PowerShell se niega a ejecutar el script, corre antes
`Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass`.

### Qué hace el instalador

1. Revisa qué falta (git, Node 20+) y lo instala con el gestor de paquetes del
   sistema — Homebrew, apt, dnf, pacman, winget o Chocolatey.
2. Encuentra tus vaults leyendo la configuración de Obsidian y te pregunta cuál.
3. Entra a tu cuenta de Cloudflare (abre el navegador).
4. Crea la base de datos y el almacén de sesiones.
5. Genera la contraseña y el secreto de sincronización.
6. Publica el servidor.
7. Sube tu vault por primera vez.
8. Programa el sync automático con el mecanismo nativo del sistema —
   launchd, el Programador de tareas, o systemd/cron.

Se puede volver a correr sin miedo: detecta lo que ya está hecho y no lo repite.

---

## Conectarlo en el celular

Al terminar, el instalador te da una dirección así:

```
https://tu-servidor.tu-cuenta.workers.dev/mcp
```

En la app de Claude, entra a los ajustes de conectores, agrega un conector
personalizado con esa dirección, y escribe la contraseña cuando la pida. Es una
sola vez.

Después basta con pedirle cosas normales: «busca en mi vault lo que tengo sobre
presupuestos», «léeme la nota del plan de 2026», «qué escribí la semana pasada».

---

## Uso diario

```bash
npm run sync            # subir los cambios ahora
npm run sync:check      # ver qué subiría, sin subir nada
npm run sync:offline    # revisar cómo se leen tus notas, sin tocar la red
npm run sync:full       # reconstruir la copia desde cero

npm run schedule:status # ver si el sync automático está activo
npm run schedule        # programarlo (por defecto cada 30 minutos)
npm run schedule:remove # quitarlo

npm run deploy          # republicar el servidor tras cambiar código
npm test                # prueba end-to-end contra el servidor publicado
```

El sync es incremental: compara el `sha256` de cada archivo con lo que ya está
arriba y manda solo lo que cambió. Un vault de 1 000 notas tarda unos segundos.

### Herramientas que ve Claude

| Herramienta | Para qué |
|---|---|
| `buscar` | Texto completo con ranking, insensible a tildes. El punto de entrada normal. |
| `leer_nota` | El contenido completo de una nota, por ruta o por título. |
| `listar` | Recorrer las carpetas del vault. |
| `campos` | Qué campos de frontmatter usa este vault. Se consulta antes de filtrar. |
| `buscar_por_campo` | Filtrar por cualquier campo del frontmatter, y ver sus valores. |
| `recientes` | Las notas tocadas últimamente. |
| `estado` | Cuántas notas hay y de cuándo es el último sync. |

---

## Privacidad

Sube el **texto** de tus notas a tu propia cuenta de Cloudflare. No pasa por
ningún servidor de terceros más que Cloudflare, y solo tú tienes la contraseña.

Si hay carpetas que prefieres que no salgan de la computadora, ponlas en
`sync/.env`:

```
EXCLUDE_PREFIXES=Privado/,Trabajo/confidencial/
```

Se comparan como prefijo de la ruta dentro del vault. Después de agregarlas,
corre `npm run sync:full` para reconstruir la copia sin ellas.

Para borrar todo lo subido:

```bash
npx wrangler d1 execute <tu-base>-db --remote --command "DELETE FROM notes_fts; DELETE FROM notes;"
```

Y para desmontarlo del todo, borra el Worker, la base D1 y el almacén KV desde
el panel de Cloudflare.

---

## Cómo está armado

```
Obsidian (tu computadora)
   │  sync/sync.mjs — lee los .md, saca el frontmatter, calcula hashes
   ▼
Cloudflare D1  ──  `notes` + `note_fields` + índice FTS5 (`notes_fts`)
   ▲
   │  src/ — Worker: OAuth 2.1 + servidor MCP, solo lectura
   ▼
Claude en el celular
```

| Archivo | Qué es |
|---|---|
| `src/index.ts` | Rutas del Worker |
| `src/mcp.ts` | Las siete herramientas MCP |
| `src/vault.ts` | Las consultas a D1 |
| `src/sync-endpoint.ts` | Por donde entra el snapshot |
| `src/auth.ts` | Pantalla de login y flujo OAuth |
| `schema.sql` | Tablas e índice de texto completo |
| `sync/sync.mjs` | El sincronizador que corre en tu computadora |
| `setup/setup.mjs` | El instalador guiado |
| `setup/schedule.mjs` | Programación de tareas por sistema operativo |

### Sobre el endpoint de sincronización

`/sync` es lo único que escribe, y va con su propio secreto — distinto del de
OAuth, así que el lado del celular no puede tocarlo. Existe para que instalar
esto sea un solo comando: la alternativa es que crees a mano un token de API de
Cloudflare con los permisos exactos, que es donde la gente abandona.

Si prefieres que el Worker sea de solo lectura absoluto, pon en `sync/.env` las
variables `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID` y `CF_API_TOKEN` (con permiso
«D1: Edit»). El sincronizador hablará directo con la API de D1, y `/sync`
quedará apagado si además quitas el secreto:

```bash
npx wrangler secret delete SYNC_SECRET
```

---

## Desarrollo

```bash
npm install
cp wrangler.example.jsonc wrangler.jsonc   # y pon los ids de tus recursos
cp sync/env.example sync/.env              # y edítalo

# Servidor local con una base de prueba
npx wrangler d1 execute <tu-base>-db --local --file=schema.sql
npm run dev

# En otra terminal, con la contraseña que pusiste en .dev.vars
node test/e2e.mjs http://127.0.0.1:8799 tu-contraseña
```

Para el servidor local hace falta un `.dev.vars` con `VAULT_PASSWORD` y
`SYNC_SECRET`. No lo subas al repositorio.

### Dos límites de D1 que hay que tener presentes

Salieron probando contra la base real, y explican decisiones del código:

- **Los patrones `LIKE` se cortan en unos 50 caracteres.** Más largo y D1
  responde `LIKE or GLOB pattern too complex`. Las rutas de un vault real pasan
  de eso sin esfuerzo, así que aquí no se usa `LIKE` para buscar por ruta ni por
  carpeta: se usa el índice FTS y comparaciones de rango.
- **Los tags viven como lista dentro de una sola columna.** Buscarlos con
  `LIKE '%x%'` daba falsos positivos: el tag caía dentro de otra palabra más
  larga. Por eso el frontmatter se guarda además en `note_fields`, un renglón
  por (nota, campo, valor), con las listas ya explotadas: así se compara el
  valor completo.

---

## Licencia

MIT.
