// Capa de consulta sobre el snapshot en D1. Todo aquí es de solo lectura.

import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  /** Snapshot del vault. El Worker solo lee de aquí. */
  VAULT_DB: D1Database;
  /** Lo usa el OAuthProvider para sus tokens, y el login para frenar fuerza bruta. */
  OAUTH_KV: KVNamespace;
  /** Secreto: `wrangler secret put VAULT_PASSWORD`. */
  VAULT_PASSWORD: string;
  /** Secreto del sincronizador. Sin él, /sync queda apagado. */
  SYNC_SECRET?: string;
  /** Nombre con que el servidor se presenta. */
  VAULT_NAME?: string;
  /** Lo inyecta @cloudflare/workers-oauth-provider en runtime. */
  OAUTH_PROVIDER: OAuthHelpers;
}

export interface NoteHit {
  path: string;
  title: string;
  folder: string;
  tags: string | null;
  frontmatter: string | null;
  extracto?: string;
}

// Columnas del índice FTS, en orden: path, title, ruta, tags, body.
// `path` va con peso 0 porque no está indexado; el título pesa más que el cuerpo.
const BM25 = "bm25(notes_fts, 0.0, 10.0, 3.0, 5.0, 1.0)";

const HIT_COLUMNS =
  "notes.path, notes.title, notes.folder, notes.tags, notes.frontmatter";

const FULL_COLUMNS = `${HIT_COLUMNS}, notes.body, notes.bytes`;

/**
 * Convierte lo que escribió el usuario en una expresión MATCH de FTS5 válida.
 *
 * Cada término se entrecomilla, así que los operadores de FTS5 (AND, OR, NOT,
 * NEAR, `*`, `^`, `:`) y los caracteres raros pasan como texto literal y no
 * pueden romper la consulta ni cambiar su significado.
 */
export function toFtsQuery(input: string, modo: "todas" | "alguna"): string {
  const terms = input
    .replace(/["*^():\-~]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  if (terms.length === 0) return "";

  const quoted = terms.map((t) => `"${t.replace(/"/g, "")}"`);
  return quoted.join(modo === "alguna" ? " OR " : " AND ");
}

/**
 * Devuelve [carpeta, desde, hasta] para seleccionar una carpeta y todo lo que
 * cuelga de ella con una comparación de rango.
 *
 * Se hace así, y no con `folder LIKE 'carpeta/%'`, por dos razones: D1 rechaza
 * los patrones LIKE de más de ~50 caracteres, y las rutas de un vault real los
 * pasan sin esfuerzo; y el rango sí puede aprovechar el índice de `folder`.
 */
function rangoDeCarpeta(carpeta: string): [string, string, string] {
  const base = carpeta.replace(/^\/+|\/+$/g, "");
  return [base, `${base}/`, `${base}/￿`];
}

export interface SearchOptions {
  consulta: string;
  limite: number;
  carpeta?: string;
  campo?: string;
  valor?: string;
}

/**
 * Búsqueda de texto completo con ranking BM25. Si la búsqueda estricta (todas
 * las palabras) no devuelve nada, reintenta con "alguna" — es lo que uno quiere
 * cuando escribió una frase de más.
 */
export async function search(
  env: Env,
  opts: SearchOptions,
): Promise<{ hits: NoteHit[]; modo: "todas" | "alguna" }> {
  for (const modo of ["todas", "alguna"] as const) {
    const expresion = toFtsQuery(opts.consulta, modo);
    if (!expresion) return { hits: [], modo };

    const filtros: string[] = [];
    const params: unknown[] = [expresion];

    if (opts.carpeta) {
      const [base, desde, hasta] = rangoDeCarpeta(opts.carpeta);
      filtros.push("AND (notes.folder = ? OR (notes.folder >= ? AND notes.folder < ?))");
      params.push(base, desde, hasta);
    }

    if (opts.campo && opts.valor) {
      filtros.push(
        `AND EXISTS (SELECT 1 FROM note_fields f
                     WHERE f.path = notes.path AND f.field = ? AND f.value = ?)`,
      );
      params.push(opts.campo, opts.valor);
    }

    params.push(opts.limite);

    const sql = `
      SELECT ${HIT_COLUMNS},
             snippet(notes_fts, 4, '«', '»', ' … ', 26) AS extracto
      FROM notes_fts
      JOIN notes ON notes.path = notes_fts.path
      WHERE notes_fts MATCH ?
      ${filtros.join("\n      ")}
      ORDER BY ${BM25}
      LIMIT ?`;

    const { results } = await env.VAULT_DB.prepare(sql)
      .bind(...params)
      .all<NoteHit>();

    if (results.length > 0) return { hits: results, modo };
    if (modo === "alguna") return { hits: [], modo };
  }

  return { hits: [], modo: "alguna" };
}

export interface FullNote extends NoteHit {
  body: string;
  bytes: number;
}

/**
 * Busca la nota por ruta exacta; si no da, por título exacto; y si tampoco,
 * por el índice de texto sobre título y ruta.
 *
 * El respaldo va por FTS y no por `LIKE '%…%'` a propósito: D1 rechaza los
 * patrones LIKE de más de ~50 caracteres, y las rutas de un vault real pasan
 * de eso a cada rato.
 */
export async function readNote(
  env: Env,
  ruta: string,
): Promise<{ nota: FullNote | null; candidatos: NoteHit[] }> {
  const limpia = ruta.replace(/^\/+/, "").trim();
  const sinExt = limpia.replace(/\.md$/, "");

  const exacta = await env.VAULT_DB.prepare(
    `SELECT ${FULL_COLUMNS} FROM notes
     WHERE notes.path = ? OR notes.path = ? OR notes.title = ?
     ORDER BY CASE WHEN notes.path = ? THEN 0 ELSE 1 END
     LIMIT 1`,
  )
    .bind(limpia, `${limpia}.md`, sinExt, limpia)
    .first<FullNote>();

  if (exacta) return { nota: exacta, candidatos: [] };

  const expresion = toFtsQuery(sinExt.split("/").join(" "), "todas");
  if (!expresion) return { nota: null, candidatos: [] };

  const { results } = await env.VAULT_DB.prepare(
    `SELECT ${FULL_COLUMNS}
     FROM notes_fts
     JOIN notes ON notes.path = notes_fts.path
     WHERE notes_fts MATCH ?
     ORDER BY ${BM25}
     LIMIT 12`,
  )
    .bind(`{title ruta} : (${expresion})`)
    .all<FullNote>();

  if (results.length === 1) return { nota: results[0], candidatos: [] };
  return { nota: null, candidatos: results };
}

/** Lista las subcarpetas y las notas que hay directamente bajo `carpeta`. */
export async function list(
  env: Env,
  carpeta: string,
): Promise<{ subcarpetas: { nombre: string; notas: number }[]; notas: NoteHit[] }> {
  const [base, desde, hasta] = rangoDeCarpeta(carpeta);
  const prefijo = base ? `${base}/` : "";

  const notas = await env.VAULT_DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM notes WHERE notes.folder = ? ORDER BY notes.title LIMIT 300`,
  )
    .bind(base)
    .all<NoteHit>();

  // Un nivel de subcarpetas: recorta la ruta al primer segmento tras el prefijo.
  // En la raíz (base = "") el rango sería "/" … "/￿", que no calza con
  // nada, así que ahí se piden todas las carpetas.
  const { results: hijas } = await (base
    ? env.VAULT_DB.prepare(
        `SELECT folder, COUNT(*) AS notas FROM notes
         WHERE folder >= ? AND folder < ?
         GROUP BY folder`,
      ).bind(desde, hasta)
    : env.VAULT_DB.prepare(
        `SELECT folder, COUNT(*) AS notas FROM notes
         WHERE folder <> ''
         GROUP BY folder`,
      )
  ).all<{ folder: string; notas: number }>();

  const acumulado = new Map<string, number>();
  for (const h of hijas) {
    const primer = h.folder.slice(prefijo.length).split("/")[0];
    if (!primer) continue;
    acumulado.set(primer, (acumulado.get(primer) ?? 0) + h.notas);
  }

  const subcarpetas = [...acumulado.entries()]
    .map(([nombre, notas]) => ({ nombre, notas }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));

  return { subcarpetas, notas: notas.results };
}

/**
 * Filtra por un campo del frontmatter, cualquiera que sea.
 *
 * El nombre del campo va como parámetro enlazado contra `note_fields`, no
 * interpolado en el SQL: funciona con los campos de cualquier vault sin lista
 * blanca y sin riesgo de inyección.
 */
export async function byField(
  env: Env,
  campo: string,
  valor: string,
  limite: number,
): Promise<NoteHit[]> {
  const { results } = await env.VAULT_DB.prepare(
    `SELECT ${HIT_COLUMNS}
     FROM note_fields f
     JOIN notes ON notes.path = f.path
     WHERE f.field = ? AND f.value = ?
     ORDER BY notes.mtime DESC, notes.title
     LIMIT ?`,
  )
    .bind(campo, valor, limite)
    .all<NoteHit>();

  return results;
}

/** Los campos de frontmatter que existen en el vault, con cuántas notas cada uno. */
export async function fields(
  env: Env,
  limite: number,
): Promise<{ campo: string; notas: number; valores: number }[]> {
  const { results } = await env.VAULT_DB.prepare(
    `SELECT field AS campo,
            COUNT(DISTINCT path)  AS notas,
            COUNT(DISTINCT value) AS valores
     FROM note_fields
     GROUP BY field
     ORDER BY notas DESC, field
     LIMIT ?`,
  )
    .bind(limite)
    .all<{ campo: string; notas: number; valores: number }>();

  return results;
}

/** Los valores que toma un campo, con cuántas notas tiene cada uno. */
export async function fieldValues(
  env: Env,
  campo: string,
  limite: number,
): Promise<{ valor: string; notas: number }[]> {
  const { results } = await env.VAULT_DB.prepare(
    `SELECT value AS valor, COUNT(*) AS notas
     FROM note_fields
     WHERE field = ?
     GROUP BY value
     ORDER BY notas DESC, value
     LIMIT ?`,
  )
    .bind(campo, limite)
    .all<{ valor: string; notas: number }>();

  return results;
}

export async function recent(env: Env, limite: number): Promise<NoteHit[]> {
  const { results } = await env.VAULT_DB.prepare(
    `SELECT ${HIT_COLUMNS} FROM notes ORDER BY notes.mtime DESC LIMIT ?`,
  )
    .bind(limite)
    .all<NoteHit>();

  return results;
}

export async function status(env: Env) {
  const totales = await env.VAULT_DB.prepare(
    `SELECT COUNT(*) AS notas, COALESCE(SUM(bytes), 0) AS bytes FROM notes`,
  ).first<{ notas: number; bytes: number }>();

  const { results: meta } = await env.VAULT_DB.prepare(
    `SELECT key, value FROM meta`,
  ).all<{ key: string; value: string }>();

  const { results: carpetas } = await env.VAULT_DB.prepare(
    `SELECT CASE WHEN INSTR(folder, '/') > 0
                 THEN SUBSTR(folder, 1, INSTR(folder, '/') - 1)
                 ELSE CASE WHEN folder = '' THEN '(raíz)' ELSE folder END
            END AS carpeta,
            COUNT(*) AS notas
     FROM notes GROUP BY carpeta ORDER BY notas DESC`,
  ).all<{ carpeta: string; notas: number }>();

  return {
    notas: totales?.notas ?? 0,
    bytes: totales?.bytes ?? 0,
    meta: Object.fromEntries(meta.map((m) => [m.key, m.value])),
    carpetas,
  };
}
