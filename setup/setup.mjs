#!/usr/bin/env node
// Instalador guiado. Deja el servidor MCP desplegado, el vault subido y el
// sync programado. Se puede volver a correr sin miedo: detecta lo que ya está
// hecho y no lo repite.
//
//   node setup/setup.mjs
//
// Funciona en macOS, Windows y Linux.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OS = platform(); // 'darwin' | 'win32' | 'linux'

// ------------------------------------------------------------------ presentación

const c = {
  neg: (s) => `\x1b[1m${s}\x1b[0m`,
  gris: (s) => `\x1b[90m${s}\x1b[0m`,
  verde: (s) => `\x1b[32m${s}\x1b[0m`,
  rojo: (s) => `\x1b[31m${s}\x1b[0m`,
  ama: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

let paso = 0;
const titulo = (t) => console.log(`\n${c.cyan(`── ${++paso}. ${t} `.padEnd(72, "─"))}`);
const ok = (m) => console.log(`   ${c.verde("✓")} ${m}`);
const info = (m) => console.log(`   ${c.gris("·")} ${c.gris(m)}`);
const advertir = (m) => console.log(`   ${c.ama("!")} ${m}`);

function abortar(m, ayuda) {
  console.log(`\n   ${c.rojo("✗")} ${m}`);
  if (ayuda) console.log(`\n${ayuda}\n`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function preguntar(q, porDefecto) {
  const sufijo = porDefecto ? c.gris(` [${porDefecto}]`) : "";
  const r = (await rl.question(`   ${q}${sufijo}: `)).trim();
  return r || porDefecto || "";
}

async function confirmar(q, porDefecto = true) {
  const r = (await rl.question(`   ${q} ${c.gris(porDefecto ? "[S/n]" : "[s/N]")}: `)).trim().toLowerCase();
  if (!r) return porDefecto;
  return r === "s" || r === "si" || r === "sí" || r === "y" || r === "yes";
}

async function elegir(q, opciones) {
  console.log(`   ${q}`);
  opciones.forEach((o, i) => console.log(`     ${c.neg(String(i + 1))}) ${o}`));
  while (true) {
    const r = (await rl.question(`   Número [1]: `)).trim() || "1";
    const n = Number.parseInt(r, 10);
    if (n >= 1 && n <= opciones.length) return n - 1;
    console.log(`   ${c.rojo("Elige un número entre 1 y " + opciones.length)}`);
  }
}

// ------------------------------------------------------------------- ejecutar

/**
 * Corre un comando y devuelve { code, stdout, stderr }.
 * En Windows los comandos de npm son .cmd, así que hace falta shell.
 */
function correr(cmd, args, { silencioso = true, entrada } = {}) {
  return new Promise((res) => {
    const hijo = spawn(cmd, args, {
      cwd: RAIZ,
      shell: OS === "win32",
      stdio: [entrada !== undefined ? "pipe" : "inherit", silencioso ? "pipe" : "inherit", "pipe"],
    });

    let out = "";
    let err = "";
    hijo.stdout?.on("data", (d) => (out += d));
    hijo.stderr?.on("data", (d) => {
      err += d;
      if (!silencioso) process.stderr.write(d);
    });

    if (entrada !== undefined) {
      hijo.stdin.write(entrada);
      hijo.stdin.end();
    }

    hijo.on("error", (e) => res({ code: 1, stdout: "", stderr: e.message }));
    hijo.on("close", (code) => res({ code: code ?? 1, stdout: out, stderr: err }));
  });
}

const npx = (args, opts) => correr(OS === "win32" ? "npx.cmd" : "npx", args, opts);
const wrangler = (args, opts) => npx(["wrangler", ...args], opts);

// --------------------------------------------------------------- 1. requisitos

async function revisarRequisitos() {
  titulo("Revisando qué hace falta");

  const mayor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (mayor < 20) {
    abortar(
      `Node ${process.versions.node} es muy viejo; hace falta 20 o más nuevo.`,
      OS === "win32"
        ? "   Instálalo con:  winget install OpenJS.NodeJS.LTS\n   o descárgalo de https://nodejs.org"
        : OS === "darwin"
          ? "   Instálalo con:  brew install node\n   o descárgalo de https://nodejs.org"
          : "   Instálalo desde el gestor de paquetes de tu distro, o de https://nodejs.org",
    );
  }
  ok(`Node ${process.versions.node}`);

  const npmv = await correr(OS === "win32" ? "npm.cmd" : "npm", ["--version"]);
  if (npmv.code !== 0) abortar("No encuentro npm, aunque Node sí está. Reinstala Node.");
  ok(`npm ${npmv.stdout.trim()}`);

  if (!existsSync(join(RAIZ, "node_modules", "wrangler"))) {
    info("Faltan las dependencias del proyecto. Instalando (tarda un par de minutos)…");
    const r = await correr(OS === "win32" ? "npm.cmd" : "npm", ["install"], { silencioso: false });
    if (r.code !== 0) abortar("`npm install` falló. Mira el error de arriba.");
    ok("Dependencias instaladas");
  } else {
    ok("Dependencias ya instaladas");
  }
}

// ------------------------------------------------------------ 2. cuenta Cloudflare

async function revisarCloudflare() {
  titulo("Cuenta de Cloudflare");

  const quien = await wrangler(["whoami"]);
  const email = quien.stdout.match(/associated with the email ([^\s.]+@[^\s.]+\.[^\s,]+)/)?.[1];

  if (quien.code === 0 && email) {
    ok(`Sesión abierta como ${email}`);
  } else {
    advertir("No hay sesión de Cloudflare en esta computadora.");
    info("Se va a abrir el navegador para que entres (o crees una cuenta gratis).");
    if (!(await confirmar("¿Seguimos?"))) abortar("Cancelado.");

    const login = await wrangler(["login"], { silencioso: false });
    if (login.code !== 0) abortar("El login de Cloudflare falló.");

    const otra = await wrangler(["whoami"]);
    if (otra.code !== 0) abortar("Sigue sin haber sesión. Prueba a mano: npx wrangler login");
    ok("Sesión iniciada");
  }

  const id = (await wrangler(["whoami"])).stdout.match(/\b([0-9a-f]{32})\b/)?.[1];
  if (id) info(`Cuenta ${id}`);
  return id;
}

// ------------------------------------------------------------------- 3. el vault

/** Lee los vaults que Obsidian tiene registrados; funciona en las tres plataformas. */
function vaultsDeObsidian() {
  const candidatos =
    OS === "darwin"
      ? [join(homedir(), "Library", "Application Support", "obsidian", "obsidian.json")]
      : OS === "win32"
        ? [
            join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json"),
          ]
        : [
            join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "obsidian", "obsidian.json"),
            join(homedir(), ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json"),
          ];

  for (const archivo of candidatos) {
    if (!existsSync(archivo)) continue;
    try {
      const j = JSON.parse(readFileSync(archivo, "utf8"));
      const rutas = Object.values(j.vaults ?? {})
        .map((v) => v.path)
        .filter((p) => typeof p === "string" && existsSync(p));
      if (rutas.length) return rutas;
    } catch {
      // Config ilegible: seguimos con el siguiente candidato.
    }
  }
  return [];
}

function contarNotas(ruta) {
  // Conteo somero: suficiente para confirmar que la carpeta es un vault.
  try {
    let n = 0;
    const recorrer = (d, prof) => {
      if (prof > 3 || n > 50) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith(".")) continue;
        if (e.isDirectory()) recorrer(join(d, e.name), prof + 1);
        else if (e.name.endsWith(".md")) n++;
        if (n > 50) return;
      }
    };
    recorrer(ruta, 0);
    return n;
  } catch {
    return 0;
  }
}

async function elegirVault() {
  titulo("Cuál vault de Obsidian");

  const detectados = vaultsDeObsidian();

  let ruta;
  if (detectados.length) {
    ok(`Obsidian tiene ${detectados.length} vault(s) registrado(s)`);
    const opciones = [...detectados.map((r) => r), "Otra carpeta (la escribo yo)"];
    const i = await elegir("¿Cuál quieres poder leer desde el celular?", opciones);
    ruta = i < detectados.length ? detectados[i] : await preguntar("Ruta completa de la carpeta del vault");
  } else {
    advertir("No encontré la configuración de Obsidian; hay que dar la ruta a mano.");
    ruta = await preguntar("Ruta completa de la carpeta del vault");
  }

  ruta = ruta.replace(/^~(?=$|[/\\])/, homedir()).trim();
  if (!existsSync(ruta)) abortar(`Esa carpeta no existe: ${ruta}`);

  const notas = contarNotas(ruta);
  if (notas === 0) {
    advertir("No vi ningún .md en los primeros niveles de esa carpeta.");
    if (!(await confirmar("¿Seguro que es un vault de Obsidian?", false))) abortar("Cancelado.");
  } else {
    ok(`${notas >= 50 ? "50+" : notas} nota(s) a la vista — parece un vault`);
  }

  const nombre = await preguntar("Nombre para mostrar del vault", ruta.split(/[/\\]/).filter(Boolean).pop());
  return { ruta, nombre };
}

// ------------------------------------------------------------ 4. recursos en la nube

/**
 * La config real trae los ids de la cuenta de quien instala, así que no va en
 * el repositorio: se crea a partir de wrangler.example.jsonc la primera vez.
 */
function leerWrangler() {
  const archivo = join(RAIZ, "wrangler.jsonc");
  const plantilla = join(RAIZ, "wrangler.example.jsonc");

  if (!existsSync(archivo)) {
    if (!existsSync(plantilla)) {
      abortar("Faltan wrangler.jsonc y wrangler.example.jsonc. ¿Está completo el repositorio?");
    }
    writeFileSync(archivo, readFileSync(plantilla, "utf8"));
    info("wrangler.jsonc creado a partir de la plantilla");
  }

  return { archivo, texto: readFileSync(archivo, "utf8") };
}

/** Busca el id de un recurso ya creado, por nombre, usando los listados de wrangler. */
async function idDeD1(nombre) {
  const r = await wrangler(["d1", "list", "--json"]);
  if (r.code !== 0) return null;
  try {
    const lista = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    return lista.find((d) => d.name === nombre)?.uuid ?? null;
  } catch {
    return null;
  }
}

async function idDeKv(titulo_) {
  const r = await wrangler(["kv", "namespace", "list"]);
  if (r.code !== 0) return null;
  try {
    const lista = JSON.parse(r.stdout.slice(r.stdout.indexOf("[")));
    return lista.find((k) => k.title === titulo_)?.id ?? null;
  } catch {
    // Sin JSON limpio, al menos intentamos sacar el id del texto.
    const m = r.stdout.match(new RegExp(`"title"\\s*:\\s*"${titulo_}"[\\s\\S]*?"id"\\s*:\\s*"([0-9a-f]{32})"`));
    return m?.[1] ?? null;
  }
}

async function crearRecursos(proyecto) {
  titulo("Creando la base de datos y el almacén de sesiones");

  const nombreD1 = `${proyecto}-db`;
  const nombreKv = `${proyecto}-oauth`;

  let d1 = await idDeD1(nombreD1);
  if (d1) {
    ok(`La base «${nombreD1}» ya existía`);
  } else {
    info(`Creando la base D1 «${nombreD1}»…`);
    const r = await wrangler(["d1", "create", nombreD1]);
    d1 = r.stdout.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/)?.[1]
      ?? (await idDeD1(nombreD1));
    if (!d1) abortar(`No pude crear la base D1.\n${r.stdout}\n${r.stderr}`);
    ok(`Base D1 creada (${d1.slice(0, 8)}…)`);
  }

  let kv = await idDeKv(nombreKv);
  if (kv) {
    ok(`El almacén «${nombreKv}» ya existía`);
  } else {
    info(`Creando el almacén KV «${nombreKv}»…`);
    const r = await wrangler(["kv", "namespace", "create", nombreKv]);
    kv = r.stdout.match(/\b([0-9a-f]{32})\b/)?.[1] ?? (await idDeKv(nombreKv));
    if (!kv) abortar(`No pude crear el almacén KV.\n${r.stdout}\n${r.stderr}`);
    ok(`Almacén KV creado (${kv.slice(0, 8)}…)`);
  }

  return { nombreD1, nombreKv, d1, kv };
}

function escribirWrangler({ proyecto, nombreVault, nombreD1, d1, kv }) {
  const { archivo, texto } = leerWrangler();

  const nuevo = texto
    .replace(/("name"\s*:\s*)"[^"]*"/, `$1"${proyecto}"`)
    .replace(/("database_name"\s*:\s*)"[^"]*"/, `$1"${nombreD1}"`)
    .replace(/("database_id"\s*:\s*)"[^"]*"/, `$1"${d1}"`)
    .replace(/("id"\s*:\s*)"[^"]*"/, `$1"${kv}"`)
    .replace(/("VAULT_NAME"\s*:\s*)"[^"]*"/, `$1"${nombreVault.replace(/"/g, "")}"`);

  writeFileSync(archivo, nuevo);
  ok("wrangler.jsonc actualizado con los ids");
}

// ---------------------------------------------------------------- 5. esquema

async function aplicarEsquema(nombreD1) {
  titulo("Creando las tablas y el índice de búsqueda");

  const r = await wrangler(["d1", "execute", nombreD1, "--remote", "--file=schema.sql", "-y"]);
  if (r.code !== 0) abortar(`No pude aplicar el esquema.\n${r.stdout}\n${r.stderr}`);
  ok("Tablas e índice de texto completo listos");
}

// ---------------------------------------------------------------- 6. secretos

const secretoFuerte = () => randomBytes(32).toString("base64url");

async function ponerSecretos() {
  titulo("Contraseñas");

  const yaEstan = await wrangler(["secret", "list"]);
  const existentes = yaEstan.code === 0 ? yaEstan.stdout : "";

  let password;
  if (existentes.includes("VAULT_PASSWORD")) {
    ok("Ya hay una contraseña de vault configurada");
    if (await confirmar("¿Quieres cambiarla?", false)) password = null;
    else password = "(sin cambios)";
  }

  if (password !== "(sin cambios)") {
    console.log(
      `\n   Esta es la contraseña que vas a escribir ${c.neg("una vez")} en el celular\n` +
        `   para autorizar el acceso al vault.\n`,
    );
    const i = await elegir("¿Cómo la definimos?", [
      "Generar una fuerte y mostrármela (recomendado)",
      "La escribo yo",
    ]);

    if (i === 0) {
      password = secretoFuerte();
    } else {
      while (true) {
        password = await preguntar("Contraseña (mínimo 12 caracteres)");
        if (password.length >= 12) break;
        console.log(`   ${c.rojo("Muy corta. Mínimo 12 caracteres.")}`);
      }
    }

    const r = await wrangler(["secret", "put", "VAULT_PASSWORD"], { entrada: `${password}\n` });
    if (r.code !== 0) abortar(`No pude guardar la contraseña.\n${r.stderr}`);
    ok("Contraseña del vault guardada como secreto del Worker");
  }

  // Secreto del sync: solo lo usa esta computadora. Se genera y no se muestra.
  let syncSecret = null;
  const envExistente = leerEnvSync();

  if (existentes.includes("SYNC_SECRET") && envExistente.SYNC_SECRET) {
    syncSecret = envExistente.SYNC_SECRET;
    ok("El secreto de sincronización ya estaba configurado");
  } else {
    syncSecret = secretoFuerte();
    const r = await wrangler(["secret", "put", "SYNC_SECRET"], { entrada: `${syncSecret}\n` });
    if (r.code !== 0) abortar(`No pude guardar el secreto de sync.\n${r.stderr}`);
    ok("Secreto de sincronización generado");
  }

  return { password, syncSecret };
}

// ----------------------------------------------------------------- 7. desplegar

async function desplegar() {
  titulo("Publicando el servidor");

  info("Esto sube el código a Cloudflare. Puede tardar medio minuto…");
  const r = await wrangler(["deploy"]);
  if (r.code !== 0) abortar(`El deploy falló.\n${r.stdout}\n${r.stderr}`);

  const url = (r.stdout + r.stderr).match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0];
  if (!url) {
    advertir("Se desplegó, pero no pude leer la URL de la salida.");
    const manual = await preguntar("Pégala aquí (la muestra el panel de Cloudflare)");
    if (!manual.startsWith("https://")) abortar("Sin la URL no puedo seguir.");
    return manual.replace(/\/+$/, "");
  }

  ok(`Publicado en ${url}`);
  return url;
}

// -------------------------------------------------------------- 8. config local

function rutaEnvSync() {
  return join(RAIZ, "sync", ".env");
}

function leerEnvSync() {
  const archivo = rutaEnvSync();
  if (!existsSync(archivo)) return {};
  const out = {};
  for (const linea of readFileSync(archivo, "utf8").split("\n")) {
    const m = linea.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function escribirEnvSync({ vaultPath, workerUrl, syncSecret }) {
  const contenido = [
    "# Generado por setup. No lo subas a ningún repositorio: trae un secreto.",
    `VAULT_PATH=${vaultPath}`,
    `WORKER_URL=${workerUrl}`,
    `SYNC_SECRET=${syncSecret}`,
    "",
    "# Carpetas que NO quieres que salgan de esta computadora, separadas por coma.",
    "# Ejemplo:  EXCLUDE_PREFIXES=Privado/,Trabajo/confidencial/",
    "EXCLUDE_PREFIXES=",
    "",
  ].join("\n");

  writeFileSync(rutaEnvSync(), contenido, { mode: 0o600 });
  ok(`Configuración local guardada en sync/.env ${c.gris("(solo lectura para ti)")}`);
}

// ------------------------------------------------------------- 9. primer sync

async function primerSync() {
  titulo("Subiendo el vault");

  const r = await correr(process.execPath, ["setup/run-sync.mjs"], { silencioso: false });
  if (r.code !== 0) {
    advertir("El primer sync falló. El servidor ya está arriba; puedes reintentar con: npm run sync");
    return false;
  }
  return true;
}

// ---------------------------------------------------------------- 10. programar

async function programar() {
  titulo("Mantenerlo al día");

  console.log(
    `\n   Para que el celular vea tus notas nuevas, esta computadora tiene que\n` +
      `   subir los cambios cada cierto tiempo. Toma unos segundos y solo sube\n` +
      `   lo que cambió.\n`,
  );

  if (!(await confirmar("¿Programo el sync automático?"))) {
    info("Listo. Cuando quieras actualizar, corre:  npm run sync");
    return;
  }

  const minutos = Number.parseInt(await preguntar("¿Cada cuántos minutos?", "30"), 10) || 30;

  const r = await correr(process.execPath, ["setup/schedule.mjs", "install", String(minutos)], {
    silencioso: false,
  });
  if (r.code !== 0) {
    advertir("No pude programarlo. Puedes hacerlo después con:  npm run schedule");
  }
}

// ---------------------------------------------------------------------- cierre

function cierre({ url, password, vaultNombre }) {
  const linea = "═".repeat(72);
  console.log(`\n${c.verde(linea)}`);
  console.log(c.neg(`  Listo. Tu vault «${vaultNombre}» ya se puede leer desde el celular.`));
  console.log(c.verde(linea));

  console.log(`\n${c.neg("  Falta un paso, y es en el celular:")}\n`);
  console.log(`  1. Abre la app de Claude y entra a los ajustes de conectores.`);
  console.log(`  2. Agrega un conector personalizado con esta dirección:\n`);
  console.log(`       ${c.cyan(`${url}/mcp`)}\n`);
  console.log(`  3. Te va a pedir una contraseña. Es esta:\n`);
  if (password && password !== "(sin cambios)") {
    console.log(`       ${c.neg(password)}\n`);
    console.log(`     ${c.ama("Guárdala en tu gestor de contraseñas: no se vuelve a mostrar.")}`);
  } else {
    console.log(`       ${c.gris("la que ya tenías configurada")}\n`);
  }

  console.log(`\n${c.neg("  Comandos útiles de aquí en adelante:")}\n`);
  console.log(`    npm run sync        subir los cambios del vault ahora`);
  console.log(`    npm run sync:check  ver qué subiría, sin subir nada`);
  console.log(`    npm run schedule    cambiar o quitar el sync automático`);
  console.log(`    npm run deploy      volver a publicar el servidor tras cambiar código\n`);
}

// -------------------------------------------------------------------- principal

async function main() {
  console.log(
    `\n${c.neg("  Obsidian MCP")} ${c.gris("— leer tu vault de Obsidian desde el celular")}\n` +
      `  ${c.gris("Instalador. Puedes cortar con Ctrl+C y volver a empezar cuando quieras.")}`,
  );

  await revisarRequisitos();
  await revisarCloudflare();

  const { ruta: vaultPath, nombre: vaultNombre } = await elegirVault();

  titulo("Nombre del servidor");
  info("Va a formar parte de su dirección en internet. Solo letras, números y guiones.");
  let proyecto = await preguntar("Nombre", "obsidian-vault-mcp");
  proyecto = proyecto.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "") || "obsidian-vault-mcp";
  ok(`Se llamará «${proyecto}»`);

  const { nombreD1, d1, kv } = await crearRecursos(proyecto);
  escribirWrangler({ proyecto, nombreVault: vaultNombre, nombreD1, d1, kv });
  await aplicarEsquema(nombreD1);

  const { password, syncSecret } = await ponerSecretos();
  const url = await desplegar();

  titulo("Guardando la configuración de esta computadora");
  escribirEnvSync({ vaultPath, workerUrl: url, syncSecret });

  await primerSync();
  await programar();

  cierre({ url, password, vaultNombre });
  rl.close();
}

main().catch((err) => {
  console.error(`\n${c.rojo("✗")} ${err.stack ?? err.message}`);
  rl.close();
  process.exit(1);
});
