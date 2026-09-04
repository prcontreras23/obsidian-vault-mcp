import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  byField,
  fieldValues,
  fields,
  list,
  readNote,
  recent,
  search,
  status,
  type Env,
  type NoteHit,
} from "./vault";

// Tope de caracteres que devuelve `leer_nota` de una vez. Las notas largas se
// leen por tramos con `desde`.
const MAX_CHARS = 40_000;

// Cuántos campos del frontmatter se muestran por resultado, y qué tan largos.
const MAX_CAMPOS = 6;
const MAX_LARGO_VALOR = 80;

const texto = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

/**
 * Resume el frontmatter de una nota en una línea.
 *
 * Se lee del JSON en vez de columnas fijas porque cada vault usa sus propios
 * campos: aquí se muestra lo que esa nota traiga, sea lo que sea.
 *
 * `destacar` fuerza que ese campo salga primero y completo. Sin eso, al
 * filtrar por un campo el resultado podía no mostrarlo — o cortado — porque
 * cayó fuera del tope de campos, que es justo el dato que uno quiere ver.
 */
function metaDeNota(h: NoteHit, destacar?: string): string {
  if (!h.frontmatter) return "";

  let fm: Record<string, unknown>;
  try {
    fm = JSON.parse(h.frontmatter) as Record<string, unknown>;
  } catch {
    return "";
  }

  const comoTexto = (valor: unknown) =>
    (Array.isArray(valor) ? valor.join(", ") : String(valor ?? "")).trim();

  const partes: string[] = [];

  if (destacar && destacar in fm) {
    const v = comoTexto(fm[destacar]);
    if (v) partes.push(`${destacar}: ${v}`);
  }

  for (const [clave, valor] of Object.entries(fm)) {
    if (clave === destacar) continue;
    if (partes.length >= MAX_CAMPOS) break;
    const v = comoTexto(valor);
    if (!v) continue;
    partes.push(`${clave}: ${v.length > MAX_LARGO_VALOR ? `${v.slice(0, MAX_LARGO_VALOR)}…` : v}`);
  }

  return partes.join(" · ");
}

function lineaDeHit(
  h: NoteHit,
  { conExtracto = true, destacar }: { conExtracto?: boolean; destacar?: string } = {},
): string {
  let out = `### ${h.title}\n\`${h.path}\``;
  const meta = metaDeNota(h, destacar);
  if (meta) out += `\n${meta}`;
  if (conExtracto && h.extracto) out += `\n> ${h.extracto.replace(/\s+/g, " ").trim()}`;
  return out;
}

export function createVaultServer(env: Env): McpServer {
  const nombreVault = env.VAULT_NAME ?? "Obsidian";

  const server = new McpServer(
    { name: "obsidian-vault", version: "1.0.0" },
    {
      instructions: [
        `Acceso de solo lectura al vault de Obsidian «${nombreVault}».`,
        "",
        "Cómo trabajarlo:",
        "- Empieza siempre por `buscar`. Es búsqueda de texto completo con ranking BM25",
        "  e ignora las tildes, así que «oracion» encuentra «oración».",
        "- `buscar` devuelve rutas y un extracto. Para el contenido completo de una nota,",
        "  llama `leer_nota` con la ruta que devolvió la búsqueda.",
        "- Para recorrer la estructura por carpetas, usa `listar`.",
        "- Este vault tiene sus propios campos de frontmatter. `campos` dice cuáles",
        "  existen y `buscar_por_campo` filtra por ellos. No supongas qué campos hay:",
        "  míralos con `campos` antes de filtrar.",
        "- `estado` dice cuántas notas hay y de cuándo es el último sync. Consúltalo si",
        "  hace falta saber qué tan fresca está la información.",
        "",
        "El snapshot se actualiza desde la computadora del usuario, así que puede tener",
        "algún desfase respecto a lo que él acaba de escribir en Obsidian. Si algo no",
        "aparece, dilo en vez de darlo por inexistente.",
      ].join("\n"),
    },
  );

  const soloLectura = { readOnlyHint: true, idempotentHint: true, openWorldHint: false };

  server.registerTool(
    "buscar",
    {
      title: "Buscar en el vault",
      description:
        "Búsqueda de texto completo en todas las notas del vault, con ranking por " +
        "relevancia (BM25) e insensible a tildes. Devuelve la ruta, el frontmatter y " +
        "un extracto de cada coincidencia. Es el punto de entrada normal: úsalo antes " +
        "que cualquier otra herramienta.",
      inputSchema: z.object({
        consulta: z.string().min(1).describe("Palabras a buscar"),
        limite: z.number().int().min(1).max(50).default(10).describe("Máximo de resultados"),
        carpeta: z
          .string()
          .optional()
          .describe("Limitar a una carpeta y lo que cuelga de ella, por ejemplo «Proyectos/2026»"),
        campo: z
          .string()
          .optional()
          .describe("Limitar a las notas con este campo de frontmatter (junto con `valor`). Mira `campos` para saber cuáles hay"),
        valor: z.string().optional().describe("Valor que debe tener ese campo"),
      }),
      annotations: soloLectura,
    },
    async ({ consulta, limite, carpeta, campo, valor }) => {
      const { hits, modo } = await search(env, { consulta, limite, carpeta, campo, valor });

      if (hits.length === 0) {
        return texto(
          `Sin resultados para «${consulta}»${carpeta ? ` en ${carpeta}` : ""}` +
            `${campo && valor ? ` con ${campo}: ${valor}` : ""}.\n\n` +
            "Se probó con todas las palabras y con cualquiera de ellas. Puede que la " +
            "nota no exista, que use otro vocabulario, o que el último sync todavía no " +
            "la haya subido (mira `estado`).",
        );
      }

      const aviso =
        modo === "alguna"
          ? "\n_(No hubo notas con todas las palabras; estos resultados traen alguna de ellas.)_\n"
          : "";

      return texto(
        `**${hits.length} resultado(s) para «${consulta}»**${aviso}\n\n` +
          hits.map((h) => lineaDeHit(h, { destacar: campo })).join("\n\n") +
          "\n\n_Usa `leer_nota` con una de esas rutas para ver la nota completa._",
      );
    },
  );

  server.registerTool(
    "leer_nota",
    {
      title: "Leer una nota",
      description:
        "Devuelve el contenido completo de una nota. Acepta la ruta exacta que dio " +
        "`buscar`, o solo el título; si hay varias notas parecidas, las lista para elegir.",
      inputSchema: z.object({
        ruta: z.string().min(1).describe("Ruta relativa al vault, o el título de la nota"),
        desde: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Carácter desde el cual seguir leyendo, para notas largas que se cortaron"),
      }),
      annotations: soloLectura,
    },
    async ({ ruta, desde }) => {
      const { nota, candidatos } = await readNote(env, ruta);

      if (!nota) {
        if (candidatos.length === 0) {
          return texto(
            `No hay ninguna nota que calce con «${ruta}». Prueba con \`buscar\` para ubicarla.`,
          );
        }
        return texto(
          `«${ruta}» calza con ${candidatos.length} notas. Vuelve a llamar con la ruta exacta:\n\n` +
            candidatos.map((c) => `- \`${c.path}\``).join("\n"),
        );
      }

      const cuerpo = nota.body ?? "";
      const trozo = cuerpo.slice(desde, desde + MAX_CHARS);
      const cortada = desde + trozo.length < cuerpo.length;

      const meta = metaDeNota(nota);
      const cabecera = [`# ${nota.title}`, `\`${nota.path}\``, meta ? `\n${meta}` : ""]
        .filter(Boolean)
        .join("\n");

      const pie = cortada
        ? `\n\n---\n_Nota cortada en ${desde + trozo.length} de ${cuerpo.length} caracteres. ` +
          `Para seguir: \`leer_nota\` con ruta «${nota.path}» y desde=${desde + trozo.length}._`
        : "";

      return texto(`${cabecera}\n\n---\n\n${trozo}${pie}`);
    },
  );

  server.registerTool(
    "listar",
    {
      title: "Listar una carpeta",
      description:
        "Muestra las subcarpetas y las notas que hay directamente dentro de una carpeta " +
        "del vault. Sin argumentos lista la raíz. Sirve para orientarse en la estructura " +
        "cuando no se sabe qué buscar.",
      inputSchema: z.object({
        carpeta: z.string().default("").describe("Carpeta a listar. Vacío = raíz"),
      }),
      annotations: soloLectura,
    },
    async ({ carpeta }) => {
      const { subcarpetas, notas } = await list(env, carpeta);

      if (!subcarpetas.length && !notas.length) {
        return texto(
          `«${carpeta || "(raíz)"}» no tiene nada, o la ruta no existe. Prueba \`listar\` sin argumentos para ver la raíz.`,
        );
      }

      const partes = [`**${carpeta || "(raíz del vault)"}**`];

      if (subcarpetas.length) {
        partes.push(
          "\n**Subcarpetas**\n" +
            subcarpetas
              .map((s) => `- \`${carpeta ? `${carpeta}/` : ""}${s.nombre}\` — ${s.notas} nota(s)`)
              .join("\n"),
        );
      }

      if (notas.length) {
        partes.push(
          `\n**Notas aquí mismo (${notas.length})**\n` +
            notas.map((n) => `- ${n.title}  \`${n.path}\``).join("\n"),
        );
      }

      return texto(partes.join("\n"));
    },
  );

  server.registerTool(
    "campos",
    {
      title: "Campos de frontmatter del vault",
      description:
        "Los campos de frontmatter que este vault usa de verdad, con cuántas notas y " +
        "cuántos valores distintos tiene cada uno. Cada vault usa los suyos, así que " +
        "consúltalo antes de filtrar con `buscar_por_campo` en vez de suponer.",
      inputSchema: z.object({
        limite: z.number().int().min(1).max(100).default(30).describe("Máximo de campos"),
      }),
      annotations: soloLectura,
    },
    async ({ limite }) => {
      const cs = await fields(env, limite);
      if (!cs.length) {
        return texto("Ninguna nota de este vault tiene frontmatter con campos.");
      }
      return texto(
        `**Campos de frontmatter en este vault**\n\n` +
          cs
            .map((c) => `- \`${c.campo}\` — ${c.notas} nota(s), ${c.valores} valor(es) distinto(s)`)
            .join("\n") +
          "\n\n_Usa `buscar_por_campo` con uno de estos campos (sin `valor`) para ver sus valores._",
      );
    },
  );

  server.registerTool(
    "buscar_por_campo",
    {
      title: "Buscar por campo del frontmatter",
      description:
        "Filtra notas por un campo del frontmatter en vez de por texto. Si omites " +
        "`valor`, devuelve los valores que ese campo toma en el vault, con su conteo — " +
        "útil para saber qué hay antes de filtrar. Los campos disponibles los da `campos`.",
      inputSchema: z.object({
        campo: z.string().min(1).describe("Campo del frontmatter, tal como lo lista `campos`"),
        valor: z
          .string()
          .optional()
          .describe("Valor exacto a buscar. Omítelo para ver los valores disponibles"),
        limite: z.number().int().min(1).max(100).default(25).describe("Máximo de resultados"),
      }),
      annotations: soloLectura,
    },
    async ({ campo, valor, limite }) => {
      if (!valor) {
        const valores = await fieldValues(env, campo, limite);
        if (!valores.length) {
          return texto(
            `Ninguna nota tiene el campo \`${campo}\`. Llama \`campos\` para ver los que sí existen.`,
          );
        }
        return texto(
          `**Valores de \`${campo}\`**\n\n` +
            valores.map((v) => `- \`${v.valor}\` — ${v.notas} nota(s)`).join("\n"),
        );
      }

      const hits = await byField(env, campo, valor, limite);
      if (!hits.length) {
        return texto(
          `Ninguna nota con \`${campo}: ${valor}\`. Llama esta misma herramienta sin \`valor\` para ver los valores que sí existen.`,
        );
      }

      return texto(
        `**${hits.length} nota(s) con \`${campo}: ${valor}\`**\n\n` +
          hits.map((h) => lineaDeHit(h, { conExtracto: false, destacar: campo })).join("\n\n"),
      );
    },
  );

  server.registerTool(
    "recientes",
    {
      title: "Notas modificadas recientemente",
      description:
        "Las notas tocadas más recientemente, de la más nueva a la más vieja. " +
        "Sirve para retomar en qué se estaba trabajando.",
      inputSchema: z.object({
        limite: z.number().int().min(1).max(50).default(15).describe("Cuántas notas devolver"),
      }),
      annotations: soloLectura,
    },
    async ({ limite }) => {
      const hits = await recent(env, limite);
      if (!hits.length) return texto("La base está vacía — parece que el sync nunca corrió.");
      return texto(
        `**Últimas ${hits.length} notas modificadas**\n\n` +
          hits.map((h) => lineaDeHit(h, { conExtracto: false })).join("\n\n"),
      );
    },
  );

  server.registerTool(
    "estado",
    {
      title: "Estado del vault",
      description:
        "Cuántas notas hay indexadas, cómo se reparten por carpeta y cuándo fue el " +
        "último sync desde la computadora. Consúltalo cuando importe saber si la " +
        "información está al día.",
      inputSchema: z.object({}),
      annotations: soloLectura,
    },
    async () => {
      const s = await status(env);

      if (s.notas === 0) {
        return texto(
          "No hay ninguna nota indexada todavía. Hay que correr el sync desde la computadora: `npm run sync`.",
        );
      }

      const ultimo = s.meta.ultimo_sync
        ? `${new Date(s.meta.ultimo_sync).toISOString().replace("T", " ").slice(0, 16)} UTC`
        : "desconocido";

      return texto(
        [
          `**Vault «${nombreVault}» — snapshot de solo lectura**`,
          "",
          `- Notas indexadas: **${s.notas}**`,
          `- Texto: ${(s.bytes / 1048576).toFixed(1)} MB`,
          `- Último sync: **${ultimo}**`,
          "",
          "**Por carpeta**",
          ...s.carpetas.map((c) => `- ${c.carpeta} — ${c.notas}`),
        ].join("\n"),
      );
    },
  );

  return server;
}
