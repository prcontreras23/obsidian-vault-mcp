#!/usr/bin/env node
// Programa (o quita) el sync periódico del vault.
//
//   node setup/schedule.mjs install [minutos]
//   node setup/schedule.mjs status
//   node setup/schedule.mjs remove
//
// Cada sistema usa su propio mecanismo, el nativo:
//   macOS    launchd  (~/Library/LaunchAgents)
//   Windows  Programador de tareas (schtasks)
//   Linux    systemd --user, y si no hay, crontab

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OS = platform();
const ETIQUETA = "com.obsidian-vault-mcp.sync";
const TAREA_WIN = "ObsidianVaultMcpSync";
const NODE = process.execPath;
const SCRIPT = join(RAIZ, "setup", "run-sync.mjs");
const LOG = join(RAIZ, "sync", "sync.log");

const ok = (m) => console.log(`   \x1b[32m✓\x1b[0m ${m}`);
const info = (m) => console.log(`   \x1b[90m· ${m}\x1b[0m`);
const err = (m) => console.log(`   \x1b[31m✗\x1b[0m ${m}`);

function correr(cmd, args, opts = {}) {
  return new Promise((res) => {
    const h = spawn(cmd, args, { shell: OS === "win32", ...opts });
    let out = "";
    let e = "";
    h.stdout?.on("data", (d) => (out += d));
    h.stderr?.on("data", (d) => (e += d));
    h.on("error", (x) => res({ code: 1, stdout: "", stderr: x.message }));
    h.on("close", (code) => res({ code: code ?? 1, stdout: out, stderr: e }));
  });
}

// ------------------------------------------------------------------------ macOS

const plistPath = () => join(homedir(), "Library", "LaunchAgents", `${ETIQUETA}.plist`);

function plist(minutos) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${ETIQUETA}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${SCRIPT}</string>
  </array>
  <key>WorkingDirectory</key><string>${RAIZ}</string>
  <key>StartInterval</key><integer>${minutos * 60}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
  <!-- Si la Mac estaba dormida a la hora que tocaba, corre al despertar. -->
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

async function instalarMac(minutos) {
  const p = plistPath();
  mkdirSync(dirname(p), { recursive: true });

  // Si ya estaba cargado, se descarga antes para que tome los cambios.
  await correr("launchctl", ["bootout", `gui/${process.getuid()}/${ETIQUETA}`]);

  writeFileSync(p, plist(minutos));

  const r = await correr("launchctl", ["bootstrap", `gui/${process.getuid()}`, p]);
  if (r.code !== 0) {
    // `bootstrap` no existe en macOS viejos; `load` sí.
    const viejo = await correr("launchctl", ["load", "-w", p]);
    if (viejo.code !== 0) {
      err(`launchd rechazó la tarea: ${r.stderr || viejo.stderr}`);
      return false;
    }
  }
  ok(`Programado con launchd, cada ${minutos} minuto(s)`);
  info(`Registro: ${LOG}`);
  return true;
}

async function quitarMac() {
  await correr("launchctl", ["bootout", `gui/${process.getuid()}/${ETIQUETA}`]);
  await correr("launchctl", ["unload", "-w", plistPath()]);
  if (existsSync(plistPath())) unlinkSync(plistPath());
  ok("Tarea de launchd quitada");
  return true;
}

async function estadoMac() {
  if (!existsSync(plistPath())) return info("No hay nada programado.");
  const r = await correr("launchctl", ["list", ETIQUETA]);
  r.code === 0
    ? ok(`Activa. Definición en ${plistPath()}`)
    : info(`El archivo existe pero launchd no la tiene cargada: ${plistPath()}`);
}

// ---------------------------------------------------------------------- Windows

async function instalarWin(minutos) {
  // schtasks toma el intervalo en minutos con /MO, hasta 1439.
  const cada = Math.min(Math.max(minutos, 1), 1439);

  await correr("schtasks", ["/Delete", "/TN", TAREA_WIN, "/F"]);

  const r = await correr("schtasks", [
    "/Create",
    "/TN", TAREA_WIN,
    "/SC", "MINUTE",
    "/MO", String(cada),
    "/TR", `"\\"${NODE}\\" \\"${SCRIPT}\\""`,
    "/F",
  ]);

  if (r.code !== 0) {
    err(`El Programador de tareas rechazó la tarea: ${r.stderr || r.stdout}`);
    info("Si dice que hacen falta permisos, abre la terminal como Administrador.");
    return false;
  }
  ok(`Programado en el Programador de tareas, cada ${cada} minuto(s)`);
  info(`Nombre de la tarea: ${TAREA_WIN}`);
  return true;
}

async function quitarWin() {
  const r = await correr("schtasks", ["/Delete", "/TN", TAREA_WIN, "/F"]);
  r.code === 0 ? ok("Tarea quitada") : info("No había ninguna tarea que quitar.");
  return true;
}

async function estadoWin() {
  const r = await correr("schtasks", ["/Query", "/TN", TAREA_WIN]);
  r.code === 0 ? ok(`Activa:\n${r.stdout.trim()}`) : info("No hay nada programado.");
}

// ------------------------------------------------------------------------ Linux

const unidadDir = () => join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd", "user");

async function tieneSystemd() {
  const r = await correr("systemctl", ["--user", "--version"]);
  return r.code === 0;
}

async function instalarLinux(minutos) {
  if (await tieneSystemd()) {
    const dir = unidadDir();
    mkdirSync(dir, { recursive: true });

    writeFileSync(
      join(dir, "obsidian-vault-mcp-sync.service"),
      `[Unit]
Description=Sube el vault de Obsidian al servidor MCP

[Service]
Type=oneshot
WorkingDirectory=${RAIZ}
ExecStart=${NODE} ${SCRIPT}
`,
    );

    writeFileSync(
      join(dir, "obsidian-vault-mcp-sync.timer"),
      `[Unit]
Description=Sync periódico del vault de Obsidian

[Timer]
OnBootSec=2min
OnUnitActiveSec=${minutos}min
Persistent=true

[Install]
WantedBy=timers.target
`,
    );

    await correr("systemctl", ["--user", "daemon-reload"]);
    const r = await correr("systemctl", ["--user", "enable", "--now", "obsidian-vault-mcp-sync.timer"]);
    if (r.code !== 0) {
      err(`systemd rechazó el temporizador: ${r.stderr}`);
      return false;
    }
    ok(`Programado con systemd, cada ${minutos} minuto(s)`);
    return true;
  }

  // Sin systemd: crontab.
  const actual = await correr("crontab", ["-l"]);
  const lineas = (actual.code === 0 ? actual.stdout.split("\n") : []).filter(
    (l) => !l.includes(SCRIPT),
  );
  lineas.push(`*/${minutos} * * * * "${NODE}" "${SCRIPT}" >> "${LOG}" 2>&1`);

  const tmp = join(tmpdir(), "ovm-cron");
  writeFileSync(tmp, `${lineas.filter(Boolean).join("\n")}\n`);
  const r = await correr("crontab", [tmp]);
  unlinkSync(tmp);

  if (r.code !== 0) {
    err(`cron rechazó la entrada: ${r.stderr}`);
    return false;
  }
  ok(`Programado con cron, cada ${minutos} minuto(s)`);
  return true;
}

async function quitarLinux() {
  if (await tieneSystemd()) {
    await correr("systemctl", ["--user", "disable", "--now", "obsidian-vault-mcp-sync.timer"]);
    for (const f of ["obsidian-vault-mcp-sync.timer", "obsidian-vault-mcp-sync.service"]) {
      const p = join(unidadDir(), f);
      if (existsSync(p)) unlinkSync(p);
    }
    await correr("systemctl", ["--user", "daemon-reload"]);
  }

  const actual = await correr("crontab", ["-l"]);
  if (actual.code === 0 && actual.stdout.includes(SCRIPT)) {
    const lineas = actual.stdout.split("\n").filter((l) => l && !l.includes(SCRIPT));
    const tmp = join(tmpdir(), "ovm-cron");
    writeFileSync(tmp, `${lineas.join("\n")}\n`);
    await correr("crontab", [tmp]);
    unlinkSync(tmp);
  }

  ok("Programación quitada");
  return true;
}

async function estadoLinux() {
  if (await tieneSystemd()) {
    const r = await correr("systemctl", ["--user", "list-timers", "obsidian-vault-mcp-sync.timer", "--no-pager"]);
    if (r.stdout.includes("obsidian-vault-mcp-sync")) return ok(`Activa:\n${r.stdout.trim()}`);
  }
  const cron = await correr("crontab", ["-l"]);
  cron.stdout?.includes(SCRIPT) ? ok("Activa vía cron") : info("No hay nada programado.");
}

// -------------------------------------------------------------------- despacho

const accion = process.argv[2] ?? "status";
const minutos = Number.parseInt(process.argv[3] ?? "30", 10) || 30;

const porSistema = {
  darwin: { install: instalarMac, remove: quitarMac, status: estadoMac },
  win32: { install: instalarWin, remove: quitarWin, status: estadoWin },
  linux: { install: instalarLinux, remove: quitarLinux, status: estadoLinux },
};

const impl = porSistema[OS];
if (!impl) {
  err(`No sé programar tareas en «${OS}». Corre \`npm run sync\` a mano cuando quieras.`);
  process.exit(1);
}

if (!existsSync(join(RAIZ, "sync", ".env"))) {
  err("Falta sync/.env — corre el instalador primero:  npm run setup");
  process.exit(1);
}

if (!["install", "remove", "status"].includes(accion)) {
  console.log("Uso: node setup/schedule.mjs [install <minutos> | remove | status]");
  process.exit(1);
}

const okey = await impl[accion](minutos);
process.exit(okey === false ? 1 : 0);
