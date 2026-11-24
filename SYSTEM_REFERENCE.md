# PP0018 · App de Supervisión (v2)

Aplicación web para **supervisar el cumplimiento de las metas PP0018** de la OGESS Bajo Mayo a partir
del HIS (`DataHIS.dbo.HIS_Nominal`). Reemplaza la matriz en Excel / HTML estático por una base
normalizada de reglas de extracción, un motor de cálculo y un tablero con resultados reales por
año, mes y establecimiento.

```
APP_SUPERVICION_PP0018_V2/
├─ db/
│  └─ 01_schema.sql          # esquema, catálogos, staging, resultados, vista
├─ server/                   # API + motor de reglas (Node/Express)
│  ├─ db.js                  # capa ODBC (msnodesqlv8)
│  ├─ server.js              # API REST + estáticos
│  ├─ services/
│  │  ├─ normalizer.js       # interpretación de reglas (códigos, edad, lab, gestante…)
│  │  ├─ importer.js         # importación transaccional de reglas
│  │  └─ engine.js           # staging, cálculo y sincronización
│  └─ scripts/
│     ├─ seed-rules.js       # carga Reglas_Extraccion_PP0018.json
│     └─ sync.js             # sincroniza un año por línea de comandos
└─ client/                   # React + Vite + Tailwind + Recharts
   └─ src/App.tsx            # reglas, CRUD, importación, reporte
```

---

## 1. Requisitos

| Componente | Versión / nota |
|---|---|
| Windows | Probado en Windows 10/11 |
| SQL Server | Instancia local con `DataHIS` y `OGESSBM` |
| ODBC Driver | **ODBC Driver 17 for SQL Server** |
| Node.js | 20 o superior |

> **¿Por qué ODBC y no el driver TCP?** En el equipo de supervisión SQL Server tiene **TCP/IP
> deshabilitado** y no se puede reiniciar el servicio. El driver `msnodesqlv8` se conecta por
> **memoria compartida / named pipes**, sin abrir puertos. Por eso `mssql` (tedious/TCP) no se usa.

---

## 2. Instalación

```powershell
# 1) Crear/actualizar la base (idempotente)
sqlcmd -S localhost -E -d BD_SUPERVISION_PP0018 -I -f 65001 -i db\01_schema.sql

# 2) Configuración del servidor
cd server
copy .env.example .env      # ajustar si hace falta
npm install

# 3) Cargar las 372 reglas de la matriz (333 base + 39 No Transmisible/Hipertensión)
node scripts/seed-rules.js

# 4) Calcular resultados de un año
node scripts/sync.js 2026
node scripts/sync.js 2025

# 5) Levantar la API
npm start                   # http://localhost:4000
```

### Desarrollo (frontend con recarga en caliente)

```powershell
# terminal 1
cd server
npm run dev                 # API en :4000

# terminal 2
cd client
npm install
npm run dev                 # UI en :5173, proxy /api -> :4000
```

### Producción local

```powershell
cd client
npm run build               # genera client/dist
cd ..\server
npm start                   # :4000 sirve la API y la UI compilada
```

Abrir <http://localhost:4000>.

### Variables de entorno (`server/.env`)

| Variable | Default | Descripción |
|---|---|---|
| `DB_SERVER` | `localhost` | Instancia SQL Server |
| `DB_DATABASE` | `BD_SUPERVISION_PP0018` | Base de supervisión |
| `DB_SOURCE_DATABASE` | `DataHIS` | Base del HIS (origen) |
| `DB_CATALOG_DATABASE` | `OGESSBM` | Catálogo de establecimientos |
| `DB_ODBC_DRIVER` | `ODBC Driver 17 for SQL Server` | Driver instalado |
| `DB_USER` / `DB_PASSWORD` | vacíos | Vacíos = autenticación de Windows |
| `DB_ENCRYPT` | `false` | `true` si el servidor exige cifrado |
| `DB_TRUST_SERVER_CERTIFICATE` | `true` | Acepta certificado autofirmado |
| `PORT` | `4000` | Puerto de la API |
| `CORS_ORIGIN` | `http://localhost:5173` | Origen permitido en desarrollo |
| `AUTH_SECRET` | (aleatorio) | Secreto para firmar los tokens de sesión. **Definirlo en producción.** |
| `AUTH_EXPIRA_HORAS` | `12` | Duración de la sesión en horas |

> Sin `AUTH_SECRET` la API genera uno temporal en cada arranque y las sesiones se invalidan al
> reiniciar. En producción use un valor aleatorio largo y mantenlo fuera del control de versiones.

---

## 3. Modelo de datos

| Tabla | Contenido |
|---|---|
| `Estrategias` | Salud Bucal, Salud Ocular, No Transmisible, PROMSA y Metales Pesados (las 5 de la matriz PP0018). `Diabetes`, `Hipertensión` y `Otras` quedan inactivas como archivo histórico |
| `UnidadesMedida` | Unidad y **tipo de agregación**: `COUNT_ROWS`, `COUNT_CITAS`, `COUNT_PACIENTES`, `SUM_LAB` |
| `Productos` / `Subproductos` | Jerarquía de la matriz. `Subproductos.es_matriz = 1` marca la base oficial (49); `archivado = 1` marca los borradores sin código (no se borran) |
| `Reglas` | Una fila por regla de extracción (condiciones normalizadas) |
| `ReglaCodigos` | Códigos de inclusión, exclusión (`es_exclusion = 1`) y **requeridos** (`es_requerido = 1`, grupos `con`) |
| `StgAtenciones` | Subconjunto del HIS del último año sincronizado (incluye `id_ups`, `perimetro_abdominal`, `valor_lab`) |
| `SupervisionResultados` | Resultado por `regla × mes × establecimiento` (cache) |
| `SyncEstado` | Bitácora de cada sincronización (filas, duración, estado) |
| `AniosFuente` | Cache de años con datos en el HIS (evita escanear 2.9M filas al abrir la app) |
| `vw_ReglasCompletas` | Reglas + códigos agregados + unidad efectiva (vista de lectura) |

**La unidad de medida es por regla** (`Reglas.id_unidad`), no por subproducto: dentro de un mismo
subproducto puede haber reglas que cuentan atenciones y otras que suman piezas. Si una regla no
tiene unidad propia se usa la del subproducto.

### Columnas añadidas para No Transmisible / Hipertensión

| Columna | Uso |
|---|---|
| `Reglas.tipo_dx` | `TIPO_DIAGNOSTICO` aplicado a la fila principal; admite conjuntos (`D,R`) |
| `Reglas.valor_lab` / `lab_modo` | `IGUAL`, `EN`, `NUMERO`, `RANGO` |
| `Reglas.lab_min` / `lab_max` / `lab_min_incl` / `lab_max_incl` | Rangos numéricos de laboratorio |
| `Reglas.id_ups` | Lista de `ID_UPS` separada por comas; `0`/`NULL` = sin filtro |
| `Reglas.pab_op` / `pab_femenino` / `pab_masculino` | Perímetro abdominal (`<=`/`>` con umbral por sexo) |
| `Reglas.restriccion` / `nivel_restriccion` | Criterios de la matriz que el HIS no permite verificar |
| `ReglaCodigos.es_requerido` / `grupo` / `valor_lab` / `tipo_dx` | Códigos "con" (todos los grupos deben existir; dentro de un grupo basta uno) |

### Resultados

`SupervisionResultados` guarda **un valor por regla, mes y establecimiento**. Se recalcula solo
cuando se pulsa **Recalcular** (o `node scripts/sync.js <año>`); editar una regla borra únicamente
sus resultados para que se recalculen. Así el tablero responde en milisegundos sin tocar el HIS.

---

## 4. Interpretación de las reglas

La matriz original mezcla texto libre con códigos. `server/services/normalizer.js` traduce cada
regla a columnas consultables:

### Códigos

| Forma | Tipo | Se busca en |
|---|---|---|
| `D1234`, `E1234` | CPMS (procedimiento) | `CODIGO_ITEM` |
| `12345` o `12345.01` | CPT (procedimiento) | `CODIGO_ITEM` |
| `A12`, `Z0128` | CIE-10 (diagnóstico) | `CODIGO_ITEM` + `TIPO_DIAGNOSTICO` |
| `99499.*` | Exclusión (salvo que la regla lo pida explícitamente) | `CODIGO_ITEM` |

- **Fila principal**: si la regla tiene procedimientos, la fila del procedimiento; si solo tiene
  diagnósticos, la fila del diagnóstico.
- Las condiciones (`TD`, `Lab`, edad, sexo, gestante, perímetro) se aplican a la **fila principal**.
- Si la regla tiene procedimiento **y** diagnóstico, el diagnóstico debe existir en la **misma cita**
  (`ID_CITA`).
- Los **códigos requeridos** ("con") se evalúan con `EXISTS` sobre la misma cita. Cada grupo
  (`grupo`) es una condición obligatoria; dentro de un grupo basta que aparezca **uno** de sus
  códigos. Un código requerido puede llevar su propio `valor_lab` y `tipo_dx`
  (p. ej. `I10X:1` = `I10X` con `VALOR_LAB = '1'`).
- Las **exclusiones** se implementan con `NOT EXISTS` sobre la misma cita.
- Si un código requerido es de tipo procedimiento, se busca en `CODIGO_ITEM`; si es CIE-10, además
  se filtra por su `tipo_dx` (si se indicó).

### Condiciones

| Texto de la matriz | Columna |
|---|---|
| `TD=D/P/R` | `Reglas.tipo_dx` → `TIPO_DIAGNOSTICO` (admite `D,R`) |
| `Lab=...`, `valor lab` | `Reglas.valor_lab` / `lab_modo` → `VALOR_LAB` |
| `Lab=1,2`, `Lab=70-99`, `Lab=>125`, `Lab=NUMERO` | `lab_modo = EN / RANGO / NUMERO` y `lab_min`/`lab_max` |
| `Id_Financiador=2` | `Reglas.id_financiador` (SIS) |
| `UPS=302701,...` | `Reglas.id_ups` → `StgAtenciones.id_ups` |
| `Perímetro <= 88 F / <= 102 M` | `pab_op` / `pab_femenino` / `pab_masculino` |
| `gestante`, `no gestante`, `puerpera` | `solo_gestante` / `excluir_gestante` → `CONDICION_GESTANTE` |
| `EDAD =< 3 M`, `< 3 AÑOS`, `> 12`, `2-11 años`, `18+`, `>= 5 años` | `edad_min_meses` / `edad_max_meses` (meses, inclusivo) |
| `M` / `F` / `ambos` | `condicion_sexo` → `GENERO` |
| `con: CODIGO:LAB:TD` | `ReglaCodigos` con `es_requerido = 1`; `|` separa grupos, `,` alternativas |

### Agregación

| Unidad | Cálculo |
|---|---|
| Atención / Procedimiento / Número | `COUNT(*)` de filas que cumplen |
| Caso / Caso Tratado | `COUNT(DISTINCT ID_CITA)` (las reglas No Transmisible/Hipertensión se cargan como **Persona**) |
| Persona | `COUNT(DISTINCT ID_PACIENTE)` |
| Sumar Lab (Piezas) | `SUM(TRY_CAST(VALOR_LAB AS INT))` (ignora LAB no numéricos) |

Las reglas que dicen *"Sumar_ valor lab"*, *"Sumar_ lab"*, *"…campo LAB"* o *"piezas"* se agregan
como **Sumar Lab**. La unidad se puede corregir por regla desde la UI.

> **Importante (agregación anual):** `SupervisionResultados` es mensual. El total anual que muestra
> la app es la **suma de los distintos mensuales**, no el distinto anual. Para indicadores de
> "personas sin repetición en el año" esto sobreestima a quienes tuvieron atención en varios meses
> (p. ej. HTA: 27.579 mensual vs 9.893 personas distintas en 2026). Los valores mensuales son
> correctos; el total anual debe interpretarse como **actividad acumulada**.

---

## 5. Sincronización

```
Recalcular (UI)  ->  POST /api/sync  ->  refreshStaging(anio)  ->  calcular(anio)
                                              |                        |
                                     TRUNCATE StgAtenciones     DELETE resultados del año
                                     INSERT filas del HIS       evalúa 342 reglas
                                     (solo códigos usados)      guarda por mes/establecimiento
```

- `StgAtenciones` se **trunca** en cada sincronización (contiene solo el último año procesado).
- `SupervisionResultados` **persiste por año**: sincronizar 2025 no borra 2026.
- Tiempos de referencia (equipo de supervisión): **2026 ≈ 82 s** (563.253 filas de staging,
  23.849 resultados, 171 reglas con datos), **2025 ≈ 29 s** (9.412 filas, 1.112 resultados).
  `HIS_Nominal` no tiene índices.
- `HIS_Nominal` solo tiene **2.944.948 filas en 2026** y **73.609 en 2025** (año parcial); por eso
  2025 produce muchos menos resultados. No es un error del motor.
- La llamada `POST /api/sync` responde **202 inmediato** y el proceso sigue en segundo plano; la UI
  consulta `GET /api/sync/estado` hasta que termina.
- Al terminar se refresca `AniosFuente` para el selector de años.

> El motor abre **una sola conexión ODBC** y serializa las consultas. Mientras corre una
> sincronización, las peticiones pesadas esperan su turno.

---

## 6. API

> Todos los endpoints exigen `Authorization: Bearer <token>`, salvo `/api/health` y
> `/api/auth/login`. Los endpoints marcados **ADMIN** responden `403` para coordinadores.

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado de la API y de SQL Server (público) |
| POST | `/api/auth/login` | `{ usuario, password }` → `{ token, usuario }` (público) |
| GET | `/api/auth/me` | Usuario y estrategias permitidas de la sesión actual |
| POST | `/api/auth/password` | `{ actual, nueva }` → cambia la propia contraseña |
| GET | `/api/usuarios` | **ADMIN** · Lista de usuarios con sus estrategias |
| POST | `/api/usuarios` | **ADMIN** · Crea usuario |
| PUT | `/api/usuarios/:id` | **ADMIN** · Actualiza usuario, rol, estado, contraseña y estrategias |
| GET | `/api/estrategias` | Estrategias con conteo de reglas |
| GET | `/api/anios` | Años disponibles (cache, sin escanear el HIS) |
| GET | `/api/establecimientos` | Catálogo OGESSBM (912 registros) |
| GET | `/api/reglas?estrategia=&anio=&mes=&establecimiento=&q=` | Reglas con su `valor` calculado |
| GET | `/api/reglas/:id` | Detalle de una regla + códigos |
| POST | `/api/reglas` | Crea regla (normaliza condiciones) |
| PUT | `/api/reglas/:id` | Actualiza regla (borra sus resultados) |
| DELETE | `/api/reglas/:id` | Elimina regla y subproductos huérfanos |
| POST | `/api/importar` | Reemplaza todas las reglas desde JSON (`{ "reglas": [...] }`) |
| GET | `/api/resumen?anio=&mes=&estrategia=&establecimiento=` | KPIs, por mes, por estrategia, top establecimientos y subproductos |
| GET | `/api/sync/estado?anio=` | Última sincronización / si hay una en curso |
| POST | `/api/sync` | `{ "anio": 2026 }` → 202 y cálculo en segundo plano |

---

## 7. Roles y seguridad

| Rol | Alcance |
|---|---|
| `ADMIN` | Ve todas las estrategias, el módulo **Análisis** y **Administración de usuarios**. Puede crear/editar/eliminar reglas, importar y recalcular. |
| `COORDINADOR` | Solo ve las estrategias asignadas en `UsuarioEstrategias`. No ve Análisis ni Administración y no puede editar, importar ni recalcular. |

- La contraseña se guarda con **scrypt + sal aleatoria**; nunca en texto plano.
- La sesión es un token **HMAC-SHA256** con expiración (12 h por defecto). El frontend lo envía como
  `Bearer` y cierra la sesión automáticamente ante un `401`.
- El backend valida el rol y las estrategias **en cada petición**; ocultar pestañas en la UI es solo
  una ayuda visual, no el control de acceso.
- Un coordinador sin estrategias asignadas no puede crearse desde la UI/API.
- No se puede desactivar al último administrador activo ni quitarse a sí mismo el rol `ADMIN`.

### Alta de usuarios por línea de comandos

```powershell
cd server

# Administrador
node scripts/crear-usuario.js --usuario admin --nombre "Administrador" --rol ADMIN --password "Admin2026!"

# Coordinador limitado a una estrategia
node scripts/crear-usuario.js --usuario coord.ocular --nombre "Coordinador Salud Ocular" `
  --rol COORDINADOR --password "Ocular2026!" --estrategias SALUD_OCULAR

# Varias estrategias: --estrategias SALUD_OCULAR,NO_TRANSMISIBLE
```

Después del primer ingreso, cambie la contraseña desde el botón **Clave** del pie del menú lateral.

---

## 8. Interfaz

- **Menú lateral retráctil**: las secciones **Estrategias**, **Análisis** y **Administración** se
  expanden/contraen y recuerdan su estado en `localStorage`.
- **Estrategias**: cada coordinador solo ve las pestañas que tiene asignadas.
- **Reglas**: tabla por estrategia con códigos, condiciones, unidad y **resultado real**; búsqueda,
  filtro por año, exportación CSV y CRUD en modal (CRUD solo para `ADMIN`).
- **Importar JSON** (`ADMIN`): reemplaza la matriz completa (misma lógica que `seed-rules.js`). Borra
  los resultados; después hay que **Recalcular**.
- **Recalcular** (`ADMIN`): sincroniza el año seleccionado y muestra el estado.
- **Reporte de Extracción** (`ADMIN`): KPIs, evolución mensual, avance por estrategia, top
  establecimientos y top subproductos, con filtros de mes, estrategia y establecimiento.
- **Usuarios y Roles** (`ADMIN`): alta, edición, activación/desactivación y asignación de estrategias.

---

## 9. Limitaciones conocidas

1. **30 reglas no se evalúan**: 28 no tienen códigos de inclusión y 2 solo tienen exclusiones. Se
   cuentan como "reglas activas" (372), pero el motor ejecuta **342**; 171 tienen datos en 2026.
2. **El total supervisado mezcla unidades** (atenciones, personas, casos). No es comparable con
   "Piezas / Sumar Lab"; el tablero lo advierte y permite filtrar por estrategia.
3. **Total anual ≠ distinto anual**: ver la nota de agregación de la sección 4. El tablero suma los
   distintos mensuales; para "personas sin repetición en el año" use el valor mensual o consulte el
   distinto anual directamente en el HIS. Ejemplos 2026: NT_20 27.579 (mensual) vs 9.893 (anual);
   NT_13 15.630 vs 15.044; NT_1 1.125 vs 1.095.
4. **Calidad de `VALOR_LAB`**: algunas reglas "Sumar Lab" encuentran valores que no parecen
   cantidades (p. ej. `rule_1038` en Otras/Comunes suma LAB de 800–1000). Se suman según la regla,
   pero conviene validar con el HIS y, si corresponde, cambiar la unidad de esa regla a *Persona* o
   *Atención* desde la UI.
5. **Marcadores de LAB categóricos**: los valores `SBU`, `G`, `IN`, `TA`, `RF`, `PEN`, `IP`, `ID`,
   `RI`, `1C`, `C`, `D`, `DIS`, `FIN` se conservan como filtros tal como vienen en la sintaxis. Si
   el HIS no registra ese marcador para un código, la regla da **0** (p. ej. varias reglas de Salud
   Bucal con `LAB=SBU`). Es un límite del dato, no del motor.
6. **Criterios no verificables en No Transmisible / Hipertensión** (se cargan con su restricción y
   quedan visibles en la UI):
   - Umbrales JNC de presión arterial (`<120/80`, `120-129/80-84`, `130-139/85-89`, `>=140/90`) y
     `Lab1/Lab2` de PA: el HIS no separa esos componentes.
   - `APP100` (sesiones educativas) no existe en el HIS; se aproximó con `C0009`/`C0010`/`C0012`.
   - `I11`, `I12`, `I13` no existen como código base; se usan `I110`, `I119`, `I120`, `I129`,
     `I130`, `I139`.
   - `UPS 302701` no tiene atenciones registradas en 2026; la regla NT_32 evalúa además
     `300201`, `303408` y `303101`.
   - `NT_3` (tabaco `Z720`) da 0 porque `Z019` y `Z720` no coinciden en la misma cita en 2026.
   - `NT_24` (emergencia `R030` + `LAB=EMG`) da 0 porque el HIS solo registra `URG`/`180`/vacío.
7. **`id_ups = 0` significa "sin filtro"**: la columna tiene `DEFAULT 0`; el motor ignora `0`/`NULL`
   para no anular las reglas que no restringen por UPS.
8. **Duplicados y variantes de la matriz** (`99499.01`–`99499.20`, reglas repetidas) se conservan
   tal como vienen; afectan el conteo de "reglas con datos".
9. **Autenticación local**: usuarios y contraseñas viven en `BD_SUPERVISION_PP0018`, sin integración con
   Active Directory/SSO. Para producción se recomienda evaluar LDAP/AD, bloqueo por intentos fallidos,
   política de contraseñas y auditoría de accesos (ver sección 7).
10. **Un solo año en staging**: los resultados históricos se conservan, pero el staging solo tiene el
    último año sincronizado.
11. **Top subproductos vs. total por estrategia**: el resumen excluye `SUM_LAB` del total por
    estrategia (registros) pero lo incluye en el top de subproductos (piezas). Los KPIs separan
    `total_registros` y `total_piezas`.

---

## 10. Problemas comunes

| Síntoma | Causa / solución |
|---|---|
| `No se pudo conectar a SQL Server` | Verificar instancia, driver ODBC 17 y autenticación de Windows |
| `sqlcmd` falla en `vw_ReglasCompletas` | Ejecutar con `-I` (QUOTED_IDENTIFIER) |
| Acentos dañados (`AtenciÃ³n`) | Ejecutar scripts con `-f 65001`; las columnas ya son `NVARCHAR` |
| `npm` bloqueado por PowerShell (`npm.ps1`) | Usar `npm.cmd` |
| El puerto 4000 está ocupado | `Get-NetTCPConnection -LocalPort 4000` y detener el proceso |
| La app tarda en abrir tras un reinicio | Revisar `AniosFuente`; no debe escanearse `HIS_Nominal` en cada carga |

---

## 11. Origen de los datos

- Reglas base: `Reglas_Extraccion_PP0018.json` (333 reglas, 2.010 códigos de inclusión, 271 exclusiones).
- Reglas No Transmisible / Hipertensión: `No Transmisible\MATRIZ_NO_TRANSMISIBLE.xlsx` (31 filas →
  39 variantes `NT_1`–`NT_39`), exportadas a `Reglas_Extraccion_PP0018_NT.json`.
- Archivo consolidado de importación: `Reglas_Extraccion_PP0018_TODAS.json` (372 reglas).
- HIS: `DataHIS.dbo.HIS_Nominal` + `DataHIS.dbo.PACIENTE` (`GENERO`, `PERIMETRO_ABDOMINAL`) +
  `OGESSBM.dbo.Establecimientos`.
- Semántica de referencia: `Qwen_sql_20261024_r21hwz95w.sql`, `matrizpp0018_dashboard.tsx` y
  `No Transmisible\SINTAXIS_NO_TRANSMISIBLE.xlsx`.

### Recarga completa

```powershell
cd server
node scripts/seed-rules.js          # carga Reglas_Extraccion_PP0018_TODAS.json (372)
# luego Recalcular 2026 y 2025 desde la UI (o node scripts/sync.js 2026)
```

> `seed-rules.js` / `POST /api/importar` con `reemplazar: true` **borran todas las reglas y
> resultados** y vuelven a cargar; después hay que recalcular cada año.

---

## 12. Consolidación 2026 (estado 07/11/2026)

### 12.1 Catálogo y estrategias

- **49 subproductos de la matriz** marcados como base oficial (`es_matriz = 1`).
- **64 subproductos válidos fuera de la matriz** conservados como complementarios (`es_matriz = 0`, activos).
- **127 subproductos sin código válido** archivados (`archivado = 1`, `activo = 0`), sin borrar historial.
- **5 estrategias activas**: `SALUD_BUCAL`, `SALUD_OCULAR`, `NO_TRANSMISIBLE`, `PROMSA`, `METALES_PESADOS`.
- `OTRAS`, `DIABETES` e `HIPERTENSION` quedaron inactivas como archivo.

### 12.2 Agregación corregida

La vista `vw_ReglasCompletas` resuelve la unidad con `COALESCE(r.id_unidad, s.id_unidad)`; por eso se
alinearon **ambos niveles** con la matriz:

| Subproducto | Unidad | Antes | Después | Total 2026 |
|---|---|---|---|---|
| `5001605` | PERSONA CAPACITADA | SUMA_LAB | PERSONA / COUNT_PACIENTES | 40,575 (antes 717,263) |
| `4398801` | FAMILIA | ATENCION / COUNT_ROWS | FAMILIA / COUNT_PACIENTES | 40,408 (antes 124,012) |
| `5001508` | PERSONA TAMIZADA | CASO / COUNT_CITAS | PERSONA / COUNT_PACIENTES | 13,023 (antes 13,249; ver 12.8) |

### 12.3 Rendimiento de Reportes Nominales

- Los prefijos CIE se expanden contra los códigos realmente presentes en el staging y se comparan con
  `codigo_norm IN (...)`, en lugar de `LIKE 'pref%'` repetidos.
- Índices de apoyo: `IX_Stg_anio_norm (anio, codigo_norm)` e `IX_Stg_anio_cita (anio, id_cita)`.
- `SALUD_OCULAR` pasó de **237 s a 9.2 s**; el resto de estrategias responde en ≤ 3.2 s.

### 12.4 Subproductos no calculables

- `0086601`, `7398701`, `4398702`, `4398703`: indicadores poblacionales/de encuesta; no existen en el HIS.
- `5000701`, `5000704`, `5000705`, `5000804`, `5000814`, `5000815`, `5000816`, `5000817`, `5000818`:
  Salud Bucal sin lista completa de CPMS en ninguna fuente; quedan en cero hasta completar la fuente.

### 12.5 Limitación de la fuente

`DataHIS.dbo.PACIENTE` tiene los campos de nombre en `NULL` para todos los registros. El reporte nominal
muestra Red, Microred, Establecimiento, Fecha, DNI, Edad y Sexo; el nombre del paciente queda vacío.

### 12.6 Pendiente de decisión

`5001101` y `5001306` (y otros de Salud Ocular) siguen con `PROCEDIMIENTO` / `COUNT_ROWS` aunque la
matriz indica `PERSONA EVALUADA`. Si se confirma el criterio, cambiarlos a `PERSONA` / `COUNT_PACIENTES`.

### 12.7 Filtros de Producto y Subproducto en ESTRATEGIAS

La pestaña de cada estrategia incorpora dos filtros en cascada sobre las reglas cargadas:

- **Producto:** lista los productos (tabla `Productos`) que tienen reglas en la estrategia. Las reglas de
  subproductos complementarios sin producto se agrupan en *Sin producto asignado*.
- **Subproducto:** se habilita según el producto elegido y muestra código y nombre; al elegir uno, la tabla
  queda acotada a sus reglas.
- El buscador de texto sigue disponible y se combina con ambos filtros. El botón **Limpiar** restablece
  búsqueda, producto y subproducto.
- El contador muestra `X de Y reglas` cuando hay filtros activos.
- Los filtros se reinician automáticamente al cambiar de estrategia o de año, y el subproducto se reinicia
  al cambiar de producto.

Soporte de API: `GET /api/reglas` devuelve `id_producto`, `producto`, `id_subproducto` y
`codigo_subproducto`, resolviendo `Productos` y `Subproductos` mediante `LEFT JOIN`. Los filtros se aplican
en el cliente, por lo que no requieren cambios de esquema ni recálculo.

### 12.8 Consistencia entre ESTRATEGIAS y Reporte Nominal (08/11/2026)

Caso validado: `NO_TRANSMISIBLE` → *Valoración clínica y tamizaje laboratorial de enfermedades crónicas no
transmisibles* → subproducto `5001508`, regla 1371. ESTRATEGIAS mostraba **12,987** y el reporte nominal
**13,232**.

La diferencia tenía dos causas independientes:

1. **Resultado del motor desactualizado.** La regla 1371 se modificó el 09/11 a las 02:02:47 (se exigió
   `tipo_diagnostico = 'D'` en `CPT 99401.13` y en `CIE Z019`), mientras corría la sincronización que
   terminó a las 02:05:04. El valor guardado correspondía a la definición anterior.
2. **El nominal contaba citas, no personas.** Los 13,232 eran `COUNT(DISTINCT id_cita)`; una persona puede
   tener varias atenciones en el año.

Correcciones aplicadas:

- `server/services/nominal.js` toma el total principal de `dbo.SupervisionResultados` (la misma fuente que
  ESTRATEGIAS) y expone además `total_citas`. La lista paginada sigue mostrando una fila por atención.
- Se recalculó 2026 completo: 98 reglas ejecutadas, 11 omitidas, 229 s.
- La UI muestra `Resultado oficial: 13,023 personas · 13,232 atenciones listadas`.

Valores verificados para `5001508` (2026):

| Métrica | Valor |
|---|---|
| Pacientes distintos en el año | 12,601 |
| Citas distintas en el año | 13,232 |
| Suma mensual de pacientes distintos (**métrica oficial**) | **13,023** |
| Resultado guardado por el motor | **13,023** |
| Pacientes con más de una cita | 563 |
| Pacientes con atención en más de un mes | 391 |

**Criterio oficial:** la cifra de ESTRATEGIAS y del nominal es la suma de `COUNT(DISTINCT paciente)` por
mes y establecimiento (granularidad de `SupervisionResultados`). No es el conteo anual de personas
distintas (12,601), que siempre será menor porque descuenta a quien volvió en otro mes; para reportar ese
valor habría que cambiar la unidad de agregación y el significado del indicador.

Totales 2026 tras el recálculo: **504,152**. Por estrategia: `SALUD_OCULAR` 182,784;
`NO_TRANSMISIBLE` 133,956; `SALUD_BUCAL` 105,169; `PROMSA` 81,015; `METALES_PESADOS` 1,228.
