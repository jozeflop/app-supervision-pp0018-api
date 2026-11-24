# PP0018 Supervision API

Node.js + Express backend for the PP0018 supervision system. PostgreSQL schema files are maintained in the separate `app-supervision-pp0018-db` repository.

## Local setup

1. Install Node.js 20 or newer.
2. Run `npm ci`.
3. Copy `.env.example` to `.env` and set PostgreSQL credentials and required local data paths. Never commit `.env`.
4. Start PostgreSQL with the schema from the DB repository.
5. Run `npm run dev`; the API listens on port 4000 by default.

## Environment

Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `AUTH_SECRET`, and `CORS_ORIGIN`. Set `DB_SCHEMA_PATH` to the SQL file in your local database repository when running `npm run schema:postgres`.

Import scripts also read source workbooks, CSVs, RAR archives, and SQL files supplied separately. Provide explicit file paths to the script or configure the corresponding path variables; these source datasets are not included in this repository because they may contain sensitive health information.

The prior project-level guide is preserved in `SYSTEM_REFERENCE.md`; it includes historical SQL Server instructions alongside current PostgreSQL notes.

For import and rule scripts, pass source files as command-line arguments or set `MATRIZ_2027_PATH`, `INDICADORES_SQL_PATH`, or `RULES_JSON_PATH` in your local `.env`. Keep source workbooks, patient CSVs, JSON exports, and credentials outside Git.
