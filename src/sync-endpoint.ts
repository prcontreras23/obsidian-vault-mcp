// Endpoint por el que la computadora sube el snapshot del vault.
//
// Existe para que instalar esto sea un solo comando: la alternativa es que el
// usuario cree a mano un token de API de Cloudflare con los permisos correctos,
// que es justo donde la gente abandona. Si prefieres que el Worker sea de solo
// lectura absoluto, define CF_API_TOKEN en la computadora: el sincronizador
// entonces habla directo con la API de D1 y este endpoint nunca se usa (y sin
// SYNC_SECRET queda desactivado).
//
// Nada de lo que entra aquí llega al vault. El flujo es de un solo sentido:
// vault -> snapshot.

import type { Env } from "./vault";

/** Un par [campo, valor] del frontmatter. Las listas vienen ya explotadas. */
type Campo = [string, string];

interface NotaEntrante {
  path: string;
  title: string;
  folder: string;
  tags: string | null;
  frontmatter: string | null;
  body: string;
  bytes: number;
  hash: string;
  mtime: number;
  fields: Campo[];
}

type Cuerpo =
  | { op: "manifest" }
  | { op: "upsert"; notas: NotaEntrante[] }
  | { op: "delete"; rutas: string[] }
  | { op: "clear" }
  | { op: "meta"; total: number };

// Topes por lote. Bastante holgados para el uso normal, y a la vez un freno si
// algo manda basura.
const MAX_NOTAS_LOTE = 100;
const MAX_RUTAS_LOTE = 500;
const MAX_CAMPOS_NOTA = 200;
const MAX_LARGO_RUTA = 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Comparación en tiempo constante, sobre hashes de largo fijo. */
async function mismoSecreto(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

function esNota(v: unknown): v is NotaEntrante {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;

  if (typeof n.path !== "string" || n.path.length === 0 || n.path.length > MAX_LARGO_RUTA) return false;
  if (typeof n.title !== "string" || typeof n.folder !== "string") return false;
  if (typeof n.body !== "string" || typeof n.hash !== "string") return false;
  if (!Number.isFinite(n.bytes) || !Number.isFinite(n.mtime)) return false;

  if (!Array.isArray(n.fields) || n.fields.length > MAX_CAMPOS_NOTA) return false;
  return n.fields.every(
    (f) => Array.isArray(f) && f.length === 2 && typeof f[0] === "string" && typeof f[1] === "string",
  );
}

export async function handleSync(request: Request, env: Env): Promise<Response> {
  if (!env.SYNC_SECRET) {
    return json({ error: "El endpoint de sync está desactivado (no hay SYNC_SECRET)." }, 404);
  }

  if (request.method !== "POST") return json({ error: "Solo POST." }, 405);

  const auth = request.headers.get("Authorization") ?? "";
  const enviado = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!enviado || !(await mismoSecreto(enviado, env.SYNC_SECRET))) {
    return json({ error: "No autorizado." }, 401);
  }

  let cuerpo: Cuerpo;
  try {
    cuerpo = (await request.json()) as Cuerpo;
  } catch {
    return json({ error: "El cuerpo no es JSON válido." }, 400);
  }

  const db = env.VAULT_DB;

  switch (cuerpo.op) {
    // Los hashes que ya están arriba, para que la computadora mande solo lo que cambió.
    case "manifest": {
      const { results } = await db
        .prepare("SELECT path, hash FROM notes")
        .all<{ path: string; hash: string }>();
      return json({ ok: true, notas: results });
    }

    case "upsert": {
      if (!Array.isArray(cuerpo.notas) || cuerpo.notas.length === 0) {
        return json({ error: "Falta el arreglo `notas`." }, 400);
      }
      if (cuerpo.notas.length > MAX_NOTAS_LOTE) {
        return json({ error: `Máximo ${MAX_NOTAS_LOTE} notas por lote.` }, 400);
      }
      if (!cuerpo.notas.every(esNota)) {
        return json({ error: "Alguna nota viene con campos inválidos." }, 400);
      }

      const sentencias = cuerpo.notas.flatMap((n) => {
        const rutaPalabras = n.path.replace(/\.md$/, "").split("/").join(" ");

        const lote = [
          db.prepare("DELETE FROM notes_fts WHERE path = ?").bind(n.path),
          db.prepare("DELETE FROM note_fields WHERE path = ?").bind(n.path),
          db
            .prepare(
              `INSERT OR REPLACE INTO notes
                 (path, title, folder, tags, frontmatter, body, bytes, hash, mtime)
               VALUES (?,?,?,?,?,?,?,?,?)`,
            )
            .bind(
              n.path, n.title, n.folder, n.tags ?? null, n.frontmatter ?? null,
              n.body, n.bytes, n.hash, n.mtime,
            ),
          db
            .prepare("INSERT INTO notes_fts (path, title, ruta, tags, body) VALUES (?,?,?,?,?)")
            .bind(n.path, n.title, rutaPalabras, n.tags ?? "", n.body),
        ];

        // Todos los campos de una nota entran en una sola sentencia: un INSERT
        // por campo haría que un lote de 40 notas pasara de mil sentencias.
        if (n.fields.length) {
          const filas = n.fields.map(() => "(?,?,?)").join(",");
          const valores = n.fields.flatMap(([campo, valor]) => [n.path, campo, valor]);
          lote.push(
            db
              .prepare(`INSERT INTO note_fields (path, field, value) VALUES ${filas}`)
              .bind(...valores),
          );
        }

        return lote;
      });

      await db.batch(sentencias);
      return json({ ok: true, escritas: cuerpo.notas.length });
    }

    case "delete": {
      if (!Array.isArray(cuerpo.rutas) || cuerpo.rutas.length === 0) {
        return json({ error: "Falta el arreglo `rutas`." }, 400);
      }
      if (cuerpo.rutas.length > MAX_RUTAS_LOTE) {
        return json({ error: `Máximo ${MAX_RUTAS_LOTE} rutas por lote.` }, 400);
      }
      if (!cuerpo.rutas.every((r) => typeof r === "string" && r.length > 0)) {
        return json({ error: "Alguna ruta es inválida." }, 400);
      }

      await db.batch(
        cuerpo.rutas.flatMap((r) => [
          db.prepare("DELETE FROM notes_fts WHERE path = ?").bind(r),
          db.prepare("DELETE FROM note_fields WHERE path = ?").bind(r),
          db.prepare("DELETE FROM notes WHERE path = ?").bind(r),
        ]),
      );
      return json({ ok: true, borradas: cuerpo.rutas.length });
    }

    case "clear": {
      await db.batch([
        db.prepare("DELETE FROM notes_fts"),
        db.prepare("DELETE FROM note_fields"),
        db.prepare("DELETE FROM notes"),
      ]);
      return json({ ok: true });
    }

    case "meta": {
      await db.batch([
        db
          .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('ultimo_sync', ?)")
          .bind(new Date().toISOString()),
        db
          .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('total_notas', ?)")
          .bind(String(cuerpo.total ?? 0)),
      ]);
      return json({ ok: true });
    }

    default:
      return json({ error: "Operación desconocida." }, 400);
  }
}
