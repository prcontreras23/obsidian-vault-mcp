// Pantalla de login del servidor. Es un OAuth 2.1 de verdad (lo que exige el
// cliente de Claude), pero con un solo usuario: el dueño del vault, que se
// identifica con una contraseña guardada como secreto del Worker.

import { AuthorizationError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./vault";

const SCOPE = "vault:read";

// Freno de fuerza bruta: tras este número de fallos, la IP espera.
const MAX_INTENTOS = 8;
const VENTANA_SEGUNDOS = 900; // 15 minutos

/**
 * Compara dos secretos sin filtrar información por el tiempo que tarda.
 * Compara los hashes SHA-256, de largo fijo, para no filtrar tampoco el largo.
 */
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

function claveIntentos(request: Request): string {
  const ip = request.headers.get("CF-Connecting-IP") ?? "desconocida";
  return `intentos:${ip}`;
}

async function intentosFallidos(env: Env, request: Request): Promise<number> {
  const v = await env.OAUTH_KV.get(claveIntentos(request));
  return v ? Number.parseInt(v, 10) || 0 : 0;
}

async function registrarFallo(env: Env, request: Request): Promise<void> {
  const clave = claveIntentos(request);
  const actual = await intentosFallidos(env, request);
  await env.OAUTH_KV.put(clave, String(actual + 1), { expirationTtl: VENTANA_SEGUNDOS });
}

async function limpiarFallos(env: Env, request: Request): Promise<void> {
  await env.OAUTH_KV.delete(claveIntentos(request));
}

/**
 * Escapa texto antes de meterlo en el HTML.
 *
 * Importa de verdad: `clientName` lo elige quien registra el cliente OAuth
 * (el registro es dinámico y abierto), así que sin escapar sería una vía de
 * inyección de HTML/JS en la propia pantalla de login.
 */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ------------------------------------------------------------------- plantillas

function pagina(cuerpo: string, titulo: string): Response {
  return new Response(
    `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titulo}</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    padding: 24px;
    font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #f6f6f4; color: #1c1c1a;
  }
  .caja {
    width: 100%; max-width: 380px; background: #fff; border: 1px solid #e2e2dd;
    border-radius: 14px; padding: 28px;
    box-shadow: 0 1px 3px rgb(0 0 0 / .04), 0 8px 24px rgb(0 0 0 / .05);
  }
  h1 { margin: 0 0 4px; font-size: 19px; letter-spacing: -.01em; }
  .sub { margin: 0 0 22px; font-size: 14px; color: #6b6b64; }
  label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 7px; }
  input[type=password] {
    width: 100%; padding: 11px 13px; font-size: 16px; font-family: inherit;
    border: 1px solid #d4d4cd; border-radius: 9px; background: #fcfcfb; color: inherit;
  }
  input[type=password]:focus { outline: 2px solid #3b6ea8; outline-offset: -1px; border-color: #3b6ea8; }
  button {
    width: 100%; margin-top: 16px; padding: 12px; font-size: 15px; font-weight: 600;
    font-family: inherit; color: #fff; background: #1c1c1a; border: 0; border-radius: 9px;
    cursor: pointer;
  }
  button:hover { background: #35352f; }
  .error {
    margin: 0 0 18px; padding: 10px 12px; font-size: 14px; border-radius: 8px;
    background: #fdeceb; color: #8a231c; border: 1px solid #f6cfcc;
  }
  .pie { margin: 20px 0 0; font-size: 12.5px; color: #85857c; }
  code { font-size: 12.5px; background: #f0f0ec; padding: 1px 5px; border-radius: 4px; }
  @media (prefers-color-scheme: dark) {
    body { background: #191917; color: #ecece8; }
    .caja { background: #232320; border-color: #35352f; box-shadow: none; }
    .sub, .pie { color: #9a9a90; }
    input[type=password] { background: #1c1c1a; border-color: #3d3d36; }
    button { background: #ecece8; color: #1c1c1a; }
    button:hover { background: #cfcfc8; }
    .error { background: #3a1f1d; color: #f3b8b3; border-color: #5c2f2b; }
    code { background: #2d2d28; }
  }
</style>
</head>
<body><div class="caja">${cuerpo}</div></body>
</html>`,
    { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function formularioLogin(
  query: string,
  nombreCliente: string,
  vault: string,
  error?: string,
): Response {
  return pagina(
    `<h1>Vault «${esc(vault)}»</h1>
     <p class="sub">${esc(nombreCliente)} quiere leer tus notas de Obsidian. Solo lectura.</p>
     ${error ? `<p class="error">${esc(error)}</p>` : ""}
     <form method="POST" action="/authorize?${esc(query)}">
       <label for="pw">Contraseña del vault</label>
       <input id="pw" name="password" type="password" autocomplete="current-password"
              autofocus required>
       <button type="submit">Autorizar</button>
     </form>
     <p class="pie">Esta autorización da acceso de <strong>solo lectura</strong>.
        Nada de lo que hagas desde el celular escribe en el vault.</p>`,
    `Vault ${esc(vault)} — autorizar`,
  );
}

// ---------------------------------------------------------------------- handler

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const vault = env.VAULT_NAME ?? "Obsidian";

    if (url.pathname === "/") {
      return pagina(
        `<h1>Vault «${esc(vault)}» — MCP</h1>
         <p class="sub">Servidor MCP de solo lectura sobre un vault de Obsidian.</p>
         <p class="pie">El endpoint que se configura en el cliente es
            <code>${esc(url.origin)}/mcp</code>. Esta página no hace nada más.</p>`,
        `Vault ${esc(vault)} — MCP`,
      );
    }

    if (url.pathname !== "/authorize") {
      return new Response("No encontrado", { status: 404 });
    }

    if (!env.VAULT_PASSWORD) {
      return new Response(
        "El servidor no tiene contraseña configurada. Falta correr: wrangler secret put VAULT_PASSWORD",
        { status: 500 },
      );
    }

    // 1. Validar la solicitud OAuth. Viene en el query string, tanto en GET como
    //    en POST, porque el formulario se envía a la misma URL con sus params.
    let solicitud: AuthRequest;
    try {
      solicitud = await env.OAUTH_PROVIDER.parseAuthRequest(request);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;

      // Sin redirect_uri válido no se puede devolver el error al cliente.
      if (!error.redirectUri) {
        return new Response(error.description, { status: 400 });
      }
      const destino = new URL(error.redirectUri);
      destino.searchParams.set("error", error.code);
      destino.searchParams.set("error_description", error.description);
      if (error.state) destino.searchParams.set("state", error.state);
      if (error.issuer) destino.searchParams.set("iss", error.issuer);
      return Response.redirect(destino.toString(), 302);
    }

    const cliente = await env.OAUTH_PROVIDER.lookupClient(solicitud.clientId);
    if (!cliente) return new Response("Cliente OAuth desconocido", { status: 400 });

    const nombreCliente = cliente.clientName ?? "Una aplicación";
    const query = url.searchParams.toString();

    // 2. GET: mostrar el formulario.
    if (request.method === "GET") {
      return formularioLogin(query, nombreCliente, vault);
    }

    if (request.method !== "POST") {
      return new Response("Método no permitido", { status: 405, headers: { Allow: "GET, POST" } });
    }

    // 3. POST: verificar la contraseña.
    if ((await intentosFallidos(env, request)) >= MAX_INTENTOS) {
      return formularioLogin(
        query,
        nombreCliente,
        vault,
        "Demasiados intentos fallidos. Espera unos 15 minutos antes de volver a probar.",
      );
    }

    const form = await request.formData();
    const enviada = String(form.get("password") ?? "");

    if (!(await mismoSecreto(enviada, env.VAULT_PASSWORD))) {
      await registrarFallo(env, request);
      return formularioLogin(query, nombreCliente, vault, "Contraseña incorrecta.");
    }

    await limpiarFallos(env, request);

    // 4. Emitir el código de autorización. El scope se recorta a lo que este
    //    servidor sabe dar: lectura y nada más.
    const otorgado = solicitud.scope.filter((s) => s === SCOPE);

    const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
      request: solicitud,
      // Ojo: el userId viaja dentro del access_token, y el token va en una
      // cabecera HTTP. Tiene que ser ASCII puro — un «ñ» aquí corrompe el token.
      userId: "vault-owner",
      metadata: { clientName: cliente.clientName },
      scope: otorgado.length ? otorgado : [SCOPE],
      props: { vault },
    });

    return Response.redirect(redirectTo, 302);
  },
};
