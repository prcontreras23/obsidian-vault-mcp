// Punto de entrada del Worker.
//
//   /mcp        -> servidor MCP, protegido por OAuth  (lo que consume el celular)
//   /authorize  -> pantalla de login
//   /sync       -> por donde la computadora sube el snapshot (secreto aparte)
//   /           -> página informativa
//
// El camino que usa el celular es de solo lectura de punta a punta: ninguna
// herramienta MCP escribe. Lo único que escribe es /sync, que va con su propio
// secreto y no comparte credenciales con el lado MCP.

import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler } from "./auth";
import { createVaultServer } from "./mcp";
import { handleSync } from "./sync-endpoint";
import type { Env } from "./vault";

const mcpHandler = {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return createMcpHandler(() => createVaultServer(env))(request, env, ctx);
  },
};

const oauth = new OAuthProvider<Env>({
  apiRoute: "/mcp",
  apiHandler: mcpHandler,
  defaultHandler: authHandler,

  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/oauth/token",

  // Los clientes MCP nuevos se dan de alta solos; sin esto el conector de
  // Claude no puede registrarse.
  clientRegistrationEndpoint: "/oauth/register",
  clientIdMetadataDocumentEnabled: true,

  scopesSupported: ["vault:read"],
});

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // /sync se atiende antes del OAuth: usa su propio secreto, no tokens OAuth.
    if (new URL(request.url).pathname === "/sync") {
      return handleSync(request, env);
    }
    return oauth.fetch(request, env, ctx);
  },
};
