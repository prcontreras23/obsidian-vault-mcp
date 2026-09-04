#!/usr/bin/env node
// Sube un snapshot de los .md del vault de Obsidian a la base D1 que lee el MCP.
//
// Flujo de un solo sentido: vault -> nube. Este script NUNCA escribe en el
// vault; solo lo lee. El sync es incremental: compara el sha256 de cada archivo
// contra lo que ya está arriba y manda únicamente lo nuevo, lo cambiado y lo
// borrado.
//
//   node sync/sync.mjs             # incremental
//   node sync/sync.mjs --full      # reconstruye todo desde cero
//   node sync/sync.mjs --dry-run   # dice qué haría, sin escribir
//   node sync/sync.mjs --offline   # solo lee y parsea el vault; no toca la red
//
// Configuración por variables de entorno (ver sync/env.example):
//
//   VAULT_PATH                       la carpeta del vault           (siempre)
//   WORKER_URL + SYNC_SECRET         sube por el endpoint del Worker  (por defecto)
//   CF_ACCOUNT_ID + CF_D1_DATABASE_ID + CF_API_TOKEN
//                                    sube directo a la API de D1    (alternativa)
//
// Si defines las tres variables CF_*, se usa la API de D1 y el Worker se queda
// como solo lectura absoluto. Si no, se usa el endpoint del Worker.

import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

// ---------------------------------------------------------------- configuración

const VAULT = process.env.VAULT_PATH;

const WORKER_URL = process.env.WORKER_URL?.replace(/\/+$/, "");
const SYNC_SECRET = process.env.SYNC_SECRET;

const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DATABASE = process.env.CF_D1_DATABASE_ID;
const TOKEN = process.env.CF_API_TOKEN;

// Carpetas que nunca se recorren. Las que empiezan con punto se saltan solas,
// así que aquí solo van las que no.
const SKIP_DIRS = new Set(["node_modules"]);

// Rutas excluidas del snapshot que sale de la computadora. Se comparan como
// prefijo de la ruta relativa dentro del vault; vacío = se sube todo.
//
// Se define en sync/.env, por ejemplo:
//   EXCLUDE_PREFIXES=Privado/,Trabajo/confidencial/
const EXCLUDE_PREFIXES = (process.env.EXCLUDE_PREFIXES ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FULL = process.argv.includes("--full");
const DRY = process.argv.includes("--dry-run");
const OFFLINE = process.argv.includes("--offline");

// Notas por request. Bajo a propósito: los cuerpos son texto largo y el
// request tiene un límite de tamaño.
const BATCH_NOTES = 40;

// ------------------------------------------------------------------- utilidades

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * Parser del subconjunto de YAML que de verdad aparece en el frontmatter de
 * Obsidian: escalares, listas con guion y listas en línea. Lo que no entiende
 * lo deja como texto crudo en vez de inventar estructura.
 */
export function parseFrontmatter(text) {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, body: text };

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return { data: {}, body: text };

  const raw = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n").replace(/^\n+/, "");
  const data = {};

  let currentKey = null;
  for (const line of raw) {
    if (!line.trim() || line.trim().startsWith("#")) continue;

    // Ítem de lista: "  - valor"
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && currentKey) {
      const v = unquote(item[1].trim());
      if (v !== "") {
        if (!Array.isArray(data[currentKey])) data[currentKey] = [];
        data[currentKey].push(v);
      }
      continue;
    }

    // "clave: valor" o "clave:"
    const kv = line.match(/^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/);
    if (!kv) continue;

    const key = kv[1];
    const rest = kv[2].trim();
    currentKey = key;

    if (rest === "") {
      data[key] = [];
    } else if (rest.startsWith("[") && rest.endsWith("]")) {
      data[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => unquote(s.trim()))
        .filter((s) => s !== "");
    } else {
      data[key] = unquote(rest);
    }
  }

  // Una clave declarada como lista que nunca recibió ítems no aporta nada.
  for (const k of Object.keys(data)) {
    if (Array.isArray(data[k]) && data[k].length === 0) data[k] = "";
  }

  return { data, body };
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function asText(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v.join(", ") || null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// Topes por nota, para que un frontmatter raro no infle el snapshot.
const MAX_CAMPOS_NOTA = 200;
const MAX_LARGO_VALOR = 300;

/**
 * Convierte el frontmatter en pares [campo, valor] filtrables.
 *
 * Las listas se explotan en un par por elemento: así `tags: [a, b]` se puede
 * filtrar por `a` exacto, y no por substring dentro de la cadena entera.
 * No hay lista blanca de campos: sirve el frontmatter de cualquier vault.
 */
function aCampos(data) {
  const out = [];
  for (const [clave, valor] of Object.entries(data)) {
    if (out.length >= MAX_CAMPOS_NOTA) break;
    const items = Array.isArray(valor) ? valor : [valor];
    for (const item of items) {
      if (out.length >= MAX_CAMPOS_NOTA) break;
      const v = String(item ?? "").trim();
      if (v === "" || v.length > MAX_LARGO_VALOR) continue;
      out.push([clave, v]);
    }
  }
  return out;
}

// ------------------------------------------------------------ lectura del vault

async function walk(dir, out = []) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    if (e.isDirectory()) await walk(join(dir, e.name), out);
    else if (e.isFile() && e.name.endsWith(".md")) out.push(join(dir, e.name));
  }
  return out;
}

async function readNote(absPath) {
  const buf = await readFile(absPath);
  const info = await stat(absPath);
  const { data, body } = parseFrontmatter(buf.toString("utf8"));

  const path = relative(VAULT, absPath).split(sep).join("/");
  const folder = dirname(path) === "." ? "" : dirname(path);

  return {
    path,
    title: basename(path, ".md"),
    folder,
    tags: asText(data.tags),
    frontmatter: Object.keys(data).length ? JSON.stringify(data) : null,
    body,
    bytes: buf.length,
    hash: sha256(buf),
    mtime: Math.floor(info.mtimeMs / 1000),
    fields: aCampos(data),
  };
}

// -------------------------------------------------------------- red, con reintento

async function conReintento(fn, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const reintentable = /\b5\d\d\b|fetch failed|network|timeout|ECONN|EAI_AGAIN/i.test(err.message);
      if (!reintentable || attempt === 3) break;
      const espera = 500 * 2 ** (attempt - 1);
      console.warn(`  ⟳ ${label}: ${err.message} — reintento en ${espera}ms`);
      await new Promise((r) => setTimeout(r, espera));
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

// ---------------------------------------- transporte A: endpoint del Worker

function transporteWorker() {
  const post = (cuerpo, label) =>
    conReintento(async () => {
      const res = await fetch(`${WORKER_URL}/sync`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SYNC_SECRET}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(cuerpo),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(`${res.status} ${json?.error ?? "respuesta inesperada"}`);
      }
      return json;
    }, label);

  return {
    nombre: `Worker ${WORKER_URL}`,
    async manifest() {
      const { notas } = await post({ op: "manifest" }, "leer manifiesto");
      return new Map(notas.map((n) => [n.path, n.hash]));
    },
    upsert: (notas) => post({ op: "upsert", notas }, `subir ${notas.length}`),
    remove: (rutas) => post({ op: "delete", rutas }, `borrar ${rutas.length}`),
    clear: () => post({ op: "clear" }, "limpiar base"),
    meta: (total) => post({ op: "meta", total }, "actualizar meta"),
  };
}

// -------------------------------------- transporte B: API de D1 directa

function transporteD1() {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DATABASE}/query`;

  const ejecutar = (batch, label) =>
    conReintento(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(batch.length === 1 ? batch[0] : { batch }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        const errs = json?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ");
        throw new Error(`${res.status}${errs ? ` — ${errs}` : ""}`);
      }
      return json.result;
    }, label);

  const upsertSql = (n) => {
    const rutaPalabras = n.path.replace(/\.md$/, "").split("/").join(" ");

    const sentencias = [
      { sql: "DELETE FROM notes_fts WHERE path = ?", params: [n.path] },
      { sql: "DELETE FROM note_fields WHERE path = ?", params: [n.path] },
      {
        sql: `INSERT OR REPLACE INTO notes
                (path, title, folder, tags, frontmatter, body, bytes, hash, mtime)
              VALUES (?,?,?,?,?,?,?,?,?)`,
        params: [
          n.path, n.title, n.folder, n.tags, n.frontmatter,
          n.body, n.bytes, n.hash, n.mtime,
        ],
      },
      {
        sql: "INSERT INTO notes_fts (path, title, ruta, tags, body) VALUES (?,?,?,?,?)",
        params: [n.path, n.title, rutaPalabras, n.tags ?? "", n.body],
      },
    ];

    // Todos los campos en una sola sentencia, no uno por campo.
    if (n.fields.length) {
      sentencias.push({
        sql: `INSERT INTO note_fields (path, field, value) VALUES ${n.fields.map(() => "(?,?,?)").join(",")}`,
        params: n.fields.flatMap(([campo, valor]) => [n.path, campo, valor]),
      });
    }

    return sentencias;
  };

  return {
    nombre: `API de D1 (base ${DATABASE?.slice(0, 8)}…)`,
    async manifest() {
      const [res] = await ejecutar([{ sql: "SELECT path, hash FROM notes" }], "leer manifiesto");
      return new Map((res.results ?? []).map((r) => [r.path, r.hash]));
    },
    upsert: (notas) => ejecutar(notas.flatMap(upsertSql), `subir ${notas.length}`),
    remove: (rutas) =>
      ejecutar(
        rutas.flatMap((r) => [
          { sql: "DELETE FROM notes_fts WHERE path = ?", params: [r] },
          { sql: "DELETE FROM note_fields WHERE path = ?", params: [r] },
          { sql: "DELETE FROM notes WHERE path = ?", params: [r] },
        ]),
        `borrar ${rutas.length}`,
      ),
    clear: () =>
      ejecutar(
        [
          { sql: "DELETE FROM notes_fts" },
          { sql: "DELETE FROM note_fields" },
          { sql: "DELETE FROM notes" },
        ],
        "limpiar base",
      ),
    meta: (total) =>
      ejecutar(
        [
          {
            sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('ultimo_sync', ?)",
            params: [new Date().toISOString()],
          },
          {
            sql: "INSERT OR REPLACE INTO meta (key, value) VALUES ('total_notas', ?)",
            params: [String(total)],
          },
        ],
        "actualizar meta",
      ),
  };
}

function elegirTransporte() {
  if (ACCOUNT && DATABASE && TOKEN) return transporteD1();
  if (WORKER_URL && SYNC_SECRET) return transporteWorker();

  fail(
    "Falta configuración de destino. Define WORKER_URL y SYNC_SECRET, o bien\n" +
      "  CF_ACCOUNT_ID, CF_D1_DATABASE_ID y CF_API_TOKEN. Ver sync/env.example.",
  );
}

// ----------------------------------------------------------- reporte offline

function reporteOffline(notes) {
  const total = notes.reduce((a, n) => a + n.bytes, 0);
  console.log(`\nLeídas ${notes.length} notas · ${(total / 1048576).toFixed(2)} MB de texto\n`);

  const conFm = notes.filter((n) => n.frontmatter).length;
  console.log(`Con frontmatter: ${conFm} · sin frontmatter: ${notes.length - conFm}`);

  // Los campos que este vault usa de verdad, descubiertos del propio frontmatter.
  const porCampo = new Map();
  for (const n of notes) {
    for (const [campo, valor] of n.fields) {
      if (!porCampo.has(campo)) porCampo.set(campo, new Map());
      const vs = porCampo.get(campo);
      vs.set(valor, (vs.get(valor) ?? 0) + 1);
    }
  }

  const campos = [...porCampo.entries()].sort((a, b) => b[1].size - a[1].size);
  console.log(`\nCampos de frontmatter encontrados: ${campos.length}`);

  for (const [campo, valores] of campos.slice(0, 12)) {
    const top = [...valores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    console.log(
      `\n  ${campo} (${valores.size} valor(es)): ` +
        top.map(([v, c]) => `${v}=${c}`).join(", ") +
        (valores.size > 6 ? ", …" : ""),
    );
  }

  const sospechosas = notes.filter((n) => {
    if (!n.frontmatter) return false;
    const fm = JSON.parse(n.frontmatter);
    return Object.keys(fm).some((k) => k.length > 30 || /[:{}[\]]/.test(k));
  });
  console.log(
    sospechosas.length === 0
      ? "\n✓ Ningún frontmatter sospechoso."
      : `\n⚠ ${sospechosas.length} nota(s) con claves raras:\n` +
          sospechosas.slice(0, 10).map((n) => `   ${n.path}`).join("\n"),
  );

  const grandes = notes.filter((n) => n.bytes > 200_000);
  if (grandes.length) {
    console.log(
      `\nℹ ${grandes.length} nota(s) de más de 200 KB — se leerán por tramos:\n` +
        grandes.map((n) => `   ${(n.bytes / 1024).toFixed(0)} KB  ${n.path}`).join("\n"),
    );
  }

  console.log("\n(--offline: no se tocó la red.)");
}

// -------------------------------------------------------------------- principal

async function main() {
  if (!VAULT) fail("Falta VAULT_PATH. Ver sync/env.example.");

  const info = await stat(VAULT).catch(() => null);
  if (!info?.isDirectory()) fail(`VAULT_PATH no es una carpeta: ${VAULT}`);

  console.log(`Vault:  ${VAULT}`);

  const archivos = await walk(VAULT);
  const notes = [];
  for (const f of archivos) {
    const n = await readNote(f);
    if (EXCLUDE_PREFIXES.some((p) => n.path.startsWith(p))) continue;
    notes.push(n);
  }

  const local = new Map(notes.map((n) => [n.path, n]));
  const mb = (notes.reduce((a, n) => a + n.bytes, 0) / 1048576).toFixed(1);
  console.log(`Local:  ${local.size} notas (${mb} MB)`);

  if (OFFLINE) return reporteOffline(notes);

  const t = elegirTransporte();
  console.log(`Destino: ${t.nombre}`);

  let remoto = new Map();
  if (FULL) {
    console.log("Modo --full: se reconstruye la base completa.");
  } else {
    remoto = await t.manifest();
    console.log(`Remoto: ${remoto.size} notas arriba`);
  }

  const cambiadas = notes.filter((n) => remoto.get(n.path) !== n.hash);
  const borradas = [...remoto.keys()].filter((p) => !local.has(p));

  if (!cambiadas.length && !borradas.length) {
    console.log("✓ Nada cambió. Ya está al día.");
    await t.meta(local.size);
    return;
  }

  console.log(`Cambios: ${cambiadas.length} a subir, ${borradas.length} a borrar`);

  if (DRY) {
    for (const n of cambiadas.slice(0, 40)) console.log(`  + ${n.path}`);
    if (cambiadas.length > 40) console.log(`  … y ${cambiadas.length - 40} más`);
    for (const p of borradas.slice(0, 40)) console.log(`  - ${p}`);
    console.log("(--dry-run: no se escribió nada.)");
    return;
  }

  if (FULL) await t.clear();

  for (let i = 0; i < borradas.length; i += 200) {
    await t.remove(borradas.slice(i, i + 200));
  }
  if (borradas.length) console.log(`  − ${borradas.length} notas borradas`);

  let hechas = 0;
  for (let i = 0; i < cambiadas.length; i += BATCH_NOTES) {
    const lote = cambiadas.slice(i, i + BATCH_NOTES);
    await t.upsert(lote);
    hechas += lote.length;
    process.stdout.write(`\r  ↑ ${hechas}/${cambiadas.length} notas subidas`);
  }
  if (hechas) process.stdout.write("\n");

  await t.meta(local.size);
  console.log("✓ Sync terminado.");
}

// Solo corre si se invoca directo (así el test puede importar el parser).
if (process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))) {
  main().catch((err) => fail(err.message));
}
