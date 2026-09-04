#!/usr/bin/env node
// Prueba end-to-end contra un servidor ya corriendo: hace el baile completo de
// OAuth (registro dinámico -> login -> código -> token) y después ejercita las
// herramientas MCP.
//
// Las comprobaciones se apoyan en datos que el propio servidor devuelve, no en
// notas concretas, así que sirve igual contra un servidor local de pruebas que
// contra el desplegado con un vault real.
//
//   node test/e2e.mjs [URL] [contraseña]
//   node test/e2e.mjs                        # local, con la contraseña de .dev.vars

import { createHash, randomBytes } from "node:crypto";

const BASE = (process.argv[2] ?? "http://127.0.0.1:8799").replace(/\/+$/, "");
const PASSWORD = process.argv[3] ?? "prueba-local-1234";
const REDIRECT = "http://localhost:9999/callback";

let fallos = 0;
const ok = (m) => console.log(`  ✓ ${m}`);
const mal = (m) => {
  fallos++;
  console.log(`  ✗ ${m}`);
};
const revisar = (cond, bien, malo) => (cond ? ok(bien) : mal(malo));

const b64url = (buf) =>
  buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

console.log(`\nServidor: ${BASE}`);

// --------------------------------------------------------- 1. descubrimiento

console.log("\n[1] Descubrimiento de OAuth");

const sinAuth = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});

revisar(sinAuth.status === 401, "/mcp sin token responde 401", `/mcp sin token responde ${sinAuth.status}`);

const challenge = sinAuth.headers.get("WWW-Authenticate") ?? "";
revisar(
  challenge.includes("resource_metadata"),
  "el 401 trae WWW-Authenticate con resource_metadata",
  `WWW-Authenticate no sirve para descubrir: «${challenge}»`,
);

const asMeta = await fetch(`${BASE}/.well-known/oauth-authorization-server`).then((r) => r.json());
revisar(
  Boolean(asMeta.token_endpoint && asMeta.authorization_endpoint),
  "metadatos del servidor de autorización publicados",
  "faltan endpoints en /.well-known/oauth-authorization-server",
);

const prMeta = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`).then((r) => r.json());
revisar(
  Boolean(prMeta.authorization_servers?.length),
  "metadatos del recurso protegido publicados",
  "faltan authorization_servers en el recurso protegido",
);

// ------------------------------------------------------------- 2. registro

console.log("\n[2] Registro dinámico del cliente");

const cliente = await fetch(`${BASE}/oauth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "Prueba <script>alert(1)</script>",
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }),
}).then((r) => r.json());

revisar(
  Boolean(cliente.client_id),
  `cliente registrado (${cliente.client_id?.slice(0, 12)}…)`,
  `registro falló: ${JSON.stringify(cliente).slice(0, 200)}`,
);

if (!cliente.client_id) process.exit(1);

// ---------------------------------------------------------------- 3. login

console.log("\n[3] Pantalla de login");

const verifier = b64url(randomBytes(32));
const codeChallenge = b64url(createHash("sha256").update(verifier).digest());

const authQuery = new URLSearchParams({
  response_type: "code",
  client_id: cliente.client_id,
  redirect_uri: REDIRECT,
  scope: "vault:read",
  state: "estado-de-prueba",
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  resource: `${BASE}/mcp`,
});

const html = await fetch(`${BASE}/authorize?${authQuery}`).then((r) => r.text());

revisar(html.includes('name="password"'), "el formulario de contraseña se rinde", "no apareció el campo de contraseña");
revisar(
  !html.includes("<script>alert(1)</script>"),
  "el nombre del cliente va escapado (sin XSS)",
  "XSS: el nombre del cliente se inyectó sin escapar",
);

const malaPw = await fetch(`${BASE}/authorize?${authQuery}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: "no-es-esta" }),
  redirect: "manual",
});
revisar(
  (await malaPw.text()).includes("incorrecta"),
  "una contraseña mala se rechaza y se vuelve a pedir",
  `una contraseña mala no fue rechazada (status ${malaPw.status})`,
);

const buenaPw = await fetch(`${BASE}/authorize?${authQuery}`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD }),
  redirect: "manual",
});

const location = buenaPw.headers.get("location") ?? "";
const code = location ? new URL(location, BASE).searchParams.get("code") : null;

revisar(
  Boolean(code),
  "la contraseña correcta devuelve un código de autorización",
  `no hubo código; status ${buenaPw.status}, location «${location}»`,
);
revisar(
  location && new URL(location, BASE).searchParams.get("state") === "estado-de-prueba",
  "el `state` vuelve intacto",
  "el `state` no volvió igual",
);

if (!code) process.exit(1);

// ---------------------------------------------------------------- 4. token

console.log("\n[4] Canje del token");

const tok = await fetch(`${BASE}/oauth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: cliente.client_id,
    code_verifier: verifier,
    resource: `${BASE}/mcp`,
  }),
}).then((r) => r.json());

revisar(Boolean(tok.access_token), "access_token emitido", `no hubo token: ${JSON.stringify(tok).slice(0, 300)}`);
if (!tok.access_token) process.exit(1);

// ------------------------------------------------------------------ 5. MCP

console.log("\n[5] Protocolo MCP");

let sesion = null;

async function rpc(method, params) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${tok.access_token}`,
  };
  if (sesion) headers["Mcp-Session-Id"] = sesion;

  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: Math.floor(Math.random() * 1e6), method, params }),
  });

  const sid = res.headers.get("Mcp-Session-Id");
  if (sid) sesion = sid;

  const raw = await res.text();

  // El transporte responde JSON plano o un stream SSE, según el cliente.
  if (raw.startsWith("event:") || raw.includes("\ndata: ")) {
    const linea = raw.split("\n").find((l) => l.startsWith("data: "));
    return linea ? JSON.parse(linea.slice(6)) : { error: { message: `SSE ilegible: ${raw.slice(0, 200)}` } };
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { error: { message: `respuesta no-JSON (${res.status}): ${raw.slice(0, 200)}` } };
  }
}

async function llamar(name, args = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  if (r.error) return `__ERROR__ ${r.error.message ?? JSON.stringify(r.error)}`;
  return r.result?.content?.[0]?.text ?? "";
}

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "prueba-e2e", version: "1.0.0" },
});

revisar(
  Boolean(init.result?.serverInfo?.name),
  `initialize OK — servidor «${init.result?.serverInfo?.name}»`,
  `initialize falló: ${JSON.stringify(init).slice(0, 300)}`,
);
revisar(
  Boolean(init.result?.instructions?.includes("Obsidian")),
  "el servidor manda sus instrucciones de uso",
  "no llegaron instrucciones",
);

const lista = await rpc("tools/list", {});
const nombres = (lista.result?.tools ?? []).map((t) => t.name).sort();
const esperadas = ["buscar", "buscar_por_campo", "campos", "estado", "leer_nota", "listar", "recientes"];
revisar(
  JSON.stringify(nombres) === JSON.stringify(esperadas),
  `tools/list expone las 7 herramientas`,
  `herramientas inesperadas: ${JSON.stringify(nombres)}`,
);

// --- estado, y de aquí sale cuántas notas hay realmente
const estado = await llamar("estado");
const totalNotas = Number.parseInt(estado.match(/Notas indexadas:\s*\*\*(\d+)\*\*/)?.[1] ?? "0", 10);
revisar(
  totalNotas > 0,
  `estado reporta ${totalNotas} notas y la fecha del último sync`,
  `estado no reporta notas: ${estado.slice(0, 200)}`,
);

if (totalNotas === 0) {
  console.log("\n  (Base vacía: no se puede probar el resto. Corre el sync primero.)");
  process.exit(1);
}

// --- recientes: de aquí tomamos una nota real para las pruebas que siguen
const recientes = await llamar("recientes", { limite: 20 });
const todasLasRutas = [...recientes.matchAll(/`([^`]+\.md)`/g)].map((m) => m[1]);

// Se prefiere una nota cuyo título traiga una palabra larga: hace falta para
// las pruebas de búsqueda. Si ninguna la tiene, se usa la primera igual.
const rutas = [
  ...todasLasRutas.filter((r) =>
    r.split("/").pop().replace(/\.md$/, "").split(/[\s—–\-.,()]+/).some((p) => p.length > 5 && !/^\d+$/.test(p)),
  ),
  ...todasLasRutas,
];
revisar(
  rutas.length > 0,
  `recientes devuelve ${rutas.length} nota(s) con su ruta`,
  `recientes no devolvió rutas: ${recientes.slice(0, 200)}`,
);

if (!rutas.length) process.exit(1);

const rutaPrueba = rutas[0];
const tituloPrueba = rutaPrueba.split("/").pop().replace(/\.md$/, "");

// --- leer_nota por ruta exacta
const porRuta = await llamar("leer_nota", { ruta: rutaPrueba, desde: 0 });
revisar(
  porRuta.includes(rutaPrueba) && !porRuta.startsWith("__ERROR__"),
  `leer_nota abre por ruta exacta («${tituloPrueba.slice(0, 40)}»)`,
  `leer_nota falló con una ruta que recientes acababa de dar: ${porRuta.slice(0, 250)}`,
);

// --- leer_nota por título solo
const porTitulo = await llamar("leer_nota", { ruta: tituloPrueba, desde: 0 });
revisar(
  !porTitulo.startsWith("__ERROR__") &&
    (porTitulo.includes(rutaPrueba) || porTitulo.includes("calza con")),
  "leer_nota resuelve dando solo el título",
  `leer_nota por título falló: ${porTitulo.slice(0, 250)}`,
);

// --- una ruta larga e inexistente: el caso que reventaba con LIKE en D1
const rutaLarga = `Carpeta/Que/No/Existe/${"nombre-larguisimo-de-nota-inexistente"}-${"x".repeat(40)}.md`;
const inexistente = await llamar("leer_nota", { ruta: rutaLarga, desde: 0 });
revisar(
  !inexistente.startsWith("__ERROR__"),
  "una ruta inexistente de más de 50 caracteres no rompe la consulta",
  `una ruta larga rompió leer_nota: ${inexistente.slice(0, 200)}`,
);

// --- buscar con una palabra sacada del título de una nota que sí existe
const palabra = tituloPrueba
  .split(/[\s—–\-.,()]+/)
  .filter((p) => p.length > 5 && !/^\d+$/.test(p))[0];

if (palabra) {
  const encontrada = await llamar("buscar", { consulta: palabra, limite: 10 });
  revisar(
    !encontrada.startsWith("__ERROR__") && encontrada.includes("resultado"),
    `buscar encuentra algo con «${palabra}», tomada de una nota real`,
    `buscar falló con «${palabra}»: ${encontrada.slice(0, 250)}`,
  );
}

// --- búsqueda insensible a tildes: se le quitan las tildes a la consulta
const conTilde = tituloPrueba.match(/[a-záéíóúñ]{6,}/i)?.[0];
if (conTilde && /[áéíóúÁÉÍÓÚ]/.test(tituloPrueba)) {
  const sinTilde = conTilde.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const r = await llamar("buscar", { consulta: sinTilde, limite: 10 });
  revisar(
    r.includes("resultado"),
    `buscar ignora tildes («${sinTilde}» halla «${conTilde}»)`,
    `la búsqueda sin tildes falló: ${r.slice(0, 200)}`,
  );
}

// --- una consulta llena de sintaxis de FTS5 no debe romper nada
const rara = await llamar("buscar", { consulta: 'nota 3:14-21 "AND" (*) NEAR^', limite: 5 });
revisar(
  !rara.startsWith("__ERROR__"),
  "una consulta con «:», «-», comillas, AND y NEAR no rompe la búsqueda",
  `una consulta con sintaxis de FTS5 rompió el servidor: ${rara.slice(0, 200)}`,
);

// --- consulta vacía de términos útiles
const vacia = await llamar("buscar", { consulta: "((( )))", limite: 5 });
revisar(
  !vacia.startsWith("__ERROR__"),
  "una consulta sin términos reales se responde sin error",
  `una consulta vacía rompió el servidor: ${vacia.slice(0, 200)}`,
);

// --- listar la raíz
const raiz = await llamar("listar", { carpeta: "" });
revisar(
  raiz.includes("Subcarpetas") || raiz.includes("Notas aquí mismo"),
  "listar arma el árbol desde la raíz",
  `listar falló: ${raiz.slice(0, 250)}`,
);

// --- listar la carpeta de la nota de prueba
const carpetaPrueba = rutaPrueba.split("/").slice(0, -1).join("/");
if (carpetaPrueba) {
  const sub = await llamar("listar", { carpeta: carpetaPrueba });
  revisar(
    sub.includes(rutaPrueba) || sub.includes(tituloPrueba),
    `listar muestra la nota dentro de «${carpetaPrueba.slice(0, 40)}»`,
    `listar no encontró la nota en su propia carpeta: ${sub.slice(0, 250)}`,
  );
}

// --- campos: descubrir el frontmatter de este vault, sea cual sea
const catalogoCampos = await llamar("campos", { limite: 30 });
const camposHallados = [...catalogoCampos.matchAll(/- `([^`]+)` — (\d+) nota/g)].map((m) => ({
  campo: m[1],
  notas: Number.parseInt(m[2], 10),
}));

revisar(
  camposHallados.length > 0,
  `campos descubre ${camposHallados.length} campo(s) de frontmatter sin tenerlos cableados`,
  `campos no descubrió nada: ${catalogoCampos.slice(0, 250)}`,
);

// --- para cada uno de los tres campos más usados: catálogo de valores y filtro
for (const { campo } of camposHallados.slice(0, 3)) {
  const valores = await llamar("buscar_por_campo", { campo, limite: 10 });
  const primerValor = valores.match(/- `([^`]+)` — \d+ nota/)?.[1];

  if (!primerValor) {
    mal(`buscar_por_campo no listó valores de «${campo}»: ${valores.slice(0, 200)}`);
    continue;
  }

  const filtrado = await llamar("buscar_por_campo", { campo, valor: primerValor, limite: 10 });

  // Cada resultado debe traer ese campo con ese valor exacto — no dentro de
  // otra palabra más larga, que es lo que pasaba filtrando con LIKE.
  const bloques = filtrado.split("\n### ").slice(1);
  const correctos = bloques.filter((b) => {
    const linea = b.match(new RegExp(`${campo}: ([^\n·]+)`))?.[1] ?? "";
    return linea
      .split(",")
      .map((t) => t.trim())
      .includes(primerValor);
  });

  revisar(
    bloques.length > 0 && correctos.length === bloques.length,
    `filtrar por «${campo}: ${primerValor.slice(0, 24)}» devuelve ${bloques.length}/${bloques.length} notas correctas`,
    `filtrar por «${campo}: ${primerValor.slice(0, 24)}» trajo ${bloques.length - correctos.length} de ${bloques.length} notas que no lo tienen`,
  );
}

// --- combinar búsqueda de texto con filtro de campo
if (camposHallados.length) {
  const { campo } = camposHallados[0];
  const valores = await llamar("buscar_por_campo", { campo, limite: 5 });
  const valor = valores.match(/- `([^`]+)` — \d+ nota/)?.[1];
  if (valor) {
    const combinada = await llamar("buscar", { consulta: "a e o", limite: 5, campo, valor });
    revisar(
      !combinada.startsWith("__ERROR__"),
      `buscar acepta texto y filtro de campo a la vez (${campo})`,
      `la búsqueda combinada falló: ${combinada.slice(0, 200)}`,
    );
  }
}

// --- un campo que no existe en este vault
const campoRaro = await llamar("buscar_por_campo", { campo: "zzz_campo_inexistente", limite: 5 });
revisar(
  campoRaro.includes("Ninguna nota"),
  "buscar_por_campo avisa cuando el campo no existe",
  `respuesta rara para un campo inexistente: ${campoRaro.slice(0, 200)}`,
);

// --- un valor que no existe
const noExiste = await llamar("buscar_por_campo", {
  campo: camposHallados[0]?.campo ?? "tags",
  valor: "zzz-valor-que-no-existe",
  limite: 5,
});
revisar(
  noExiste.includes("Ninguna nota"),
  "buscar_por_campo avisa cuando el valor no existe",
  `respuesta rara para un valor inexistente: ${noExiste.slice(0, 200)}`,
);

// ------------------------------------------------------------- 6. seguridad

console.log("\n[6] Seguridad");

const tokenFalso = await fetch(`${BASE}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: "Bearer token-inventado",
  },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
revisar(tokenFalso.status === 401, "un token inventado se rechaza con 401", `un token inventado dio ${tokenFalso.status}`);

const syncSinSecreto = await fetch(`${BASE}/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ op: "manifest" }),
});
revisar(
  syncSinSecreto.status === 401 || syncSinSecreto.status === 404,
  `/sync sin secreto se rechaza (${syncSinSecreto.status})`,
  `/sync sin secreto dio ${syncSinSecreto.status} — debería ser 401 o 404`,
);

const syncSecretoMalo = await fetch(`${BASE}/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: "Bearer secreto-falso" },
  body: JSON.stringify({ op: "clear" }),
});
revisar(
  syncSecretoMalo.status === 401 || syncSecretoMalo.status === 404,
  `/sync con un secreto falso no borra nada (${syncSecretoMalo.status})`,
  `/sync aceptó un secreto falso: ${syncSecretoMalo.status}`,
);

const rutaRara = await fetch(`${BASE}/algo-que-no-existe`);
revisar(rutaRara.status === 404, "las rutas desconocidas dan 404", `ruta desconocida dio ${rutaRara.status}`);

// -------------------------------------------------------------------- cierre

console.log(fallos === 0 ? "\n✅ Todo pasó.\n" : `\n❌ ${fallos} fallo(s).\n`);
process.exit(fallos === 0 ? 0 : 1);
