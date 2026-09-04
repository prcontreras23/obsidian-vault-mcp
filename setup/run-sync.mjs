#!/usr/bin/env node
// Corre el sincronizador cargando primero sync/.env.
//
// Existe para que `npm run sync` funcione igual en macOS, Windows y Linux, sin
// depender de cómo cada shell exporta variables de entorno.
//
//   node setup/run-sync.mjs [--full] [--dry-run] [--offline]

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV = join(RAIZ, "sync", ".env");

const entorno = { ...process.env };

if (existsSync(ENV)) {
  for (const linea of readFileSync(ENV, "utf8").split("\n")) {
    const t = linea.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const clave = t.slice(0, i).trim();
    // Lo que ya venga del entorno real manda sobre el archivo.
    if (entorno[clave] === undefined) entorno[clave] = t.slice(i + 1).trim();
  }
} else if (!entorno.VAULT_PATH) {
  console.error(
    "✗ No existe sync/.env y tampoco hay variables en el entorno.\n" +
      "  Corre el instalador primero:  npm run setup",
  );
  process.exit(1);
}

const hijo = spawn(process.execPath, [join(RAIZ, "sync", "sync.mjs"), ...process.argv.slice(2)], {
  cwd: RAIZ,
  env: entorno,
  stdio: "inherit",
});

hijo.on("close", (code) => process.exit(code ?? 1));
