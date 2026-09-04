-- Snapshot de solo lectura de un vault de Obsidian.
-- El vault nunca se escribe desde aquí: el flujo va en un solo sentido.

CREATE TABLE IF NOT EXISTS notes (
  path         TEXT PRIMARY KEY,   -- ruta relativa al vault, ej. "Proyectos/2026/Plan.md"
  title        TEXT NOT NULL,      -- nombre del archivo sin extensión
  folder       TEXT NOT NULL,      -- carpeta contenedora ("" si está en la raíz)
  tags         TEXT,               -- tags del frontmatter, separados por coma (para mostrar)
  frontmatter  TEXT,               -- frontmatter completo en JSON
  body         TEXT NOT NULL,      -- cuerpo de la nota, sin el bloque de frontmatter
  bytes        INTEGER NOT NULL,
  hash         TEXT NOT NULL,      -- sha256 del archivo; base del sync incremental
  mtime        INTEGER NOT NULL    -- epoch en segundos
);

CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder);
CREATE INDEX IF NOT EXISTS idx_notes_mtime  ON notes(mtime);

-- Un renglón por (nota, campo, valor) del frontmatter.
--
-- Va así, y no como una columna por campo, porque cada vault usa los campos que
-- se le ocurran: uno tendrá `status` y `prioridad`, otro `autor` y `revista`.
-- Con esto funciona cualquiera sin tocar el esquema, y las listas (como `tags`)
-- quedan explotadas en un renglón por elemento, que es lo que hace falta para
-- filtrar por valor exacto.
CREATE TABLE IF NOT EXISTS note_fields (
  path  TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fields_field_value ON note_fields(field, value);
CREATE INDEX IF NOT EXISTS idx_fields_path        ON note_fields(path);

-- Índice de texto completo. `remove_diacritics 2` hace que "oracion" encuentre
-- "oración" y "arbol" encuentre "árbol" — imprescindible fuera del inglés.
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  path UNINDEXED,
  title,
  ruta,               -- las carpetas de la ruta como palabras, para buscarlas
  tags,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
