/**
 * normalizer.js
 * ----------------------------------------------------------------------------------------------
 * Convierte una regla "cruda" (como viene del JSON original o del formulario de la UI) en los
 * campos normalizados que usa BD_SUPERVISION_PP0018.
 *
 * Se usa tanto en scripts/seed-rules.js como en la API (alta/edicion de reglas).
 */

/* Clasificacion de codigos ------------------------------------------------ */
export function clasificarCodigo(code) {
  const c = String(code).trim();
  if (/^[DE][0-9]{4}$/i.test(c)) return 'CPMS'; // D2330, E8211 (odontologia)
  if (/^[0-9]{5}(\.[0-9]{1,2})?$/.test(c)) return 'CPT';
  if (/^[A-Z][0-9]{2}/i.test(c)) return 'CIE10';
  if (/^[A-Z][0-9]{4}$/i.test(c)) return 'CPMS';
  return 'CPT';
}

export function esCodigoExclusion(code) {
  return /^99499(\.|$)/.test(code);
}

/* Edad ------------------------------------------------------------------- */
export function parseEdadMeses(texto) {
  const t = String(texto || '').toUpperCase().trim();
  if (!t || t === '-') return { min: null, max: null, texto: null };

  // EDAD =< 3 M / EDAD <= 3M / EDAD < 3 M
  let m = t.match(/EDAD\s*(?:=<|<=|=|<)\s*(\d+)\s*M\b/);
  if (m) return { min: null, max: parseInt(m[1], 10), texto: String(texto).trim() };

  // EDAD < 3 AÑOS / EDAD < 3A
  m = t.match(/EDAD\s*<\s*(\d+)\s*A/);
  if (m) return { min: null, max: parseInt(m[1], 10) * 12 - 1, texto: String(texto).trim() };

  // EDAD > 12
  m = t.match(/EDAD\s*>\s*(\d+)/);
  if (m) return { min: parseInt(m[1], 10) * 12 + 1, max: null, texto: String(texto).trim() };

  // 5a - 59a+  (el "+" final indica que el ultimo tramo sigue abierto: 5 años a mas)
  m = t.match(/(\d+)\s*A?\s*-\s*(\d+)\s*A?\s*\+/);
  if (m) return { min: parseInt(m[1], 10) * 12, max: null, texto: String(texto).trim() };

  // 2-11 años
  m = t.match(/(\d+)\s*-\s*(\d+)\s*A/);
  if (m) {
    return {
      min: parseInt(m[1], 10) * 12,
      max: parseInt(m[2], 10) * 12 + 11,
      texto: String(texto).trim()
    };
  }

  // >= 18 años / > 12 años / mayores de 40 años
  m = t.match(/(?:>=|=>|>|MAYORES?\s+(?:DE|A)?)\s*(\d+)\s*A/);
  if (m) return { min: parseInt(m[1], 10) * 12, max: null, texto: String(texto).trim() };

  // <= 5 años / menores de 5 años
  m = t.match(/(?:<=|=<|<|MENORES?\s+(?:DE|A)?)\s*(\d+)\s*A/);
  if (m) return { min: null, max: parseInt(m[1], 10) * 12 - 1, texto: String(texto).trim() };

  // >= 18 años / 18+
  m = t.match(/(\d+)\s*\+/);
  if (m) return { min: parseInt(m[1], 10) * 12, max: null, texto: String(texto).trim() };

  return { min: null, max: null, texto: String(texto).trim() };
}

/* Laboratorio ------------------------------------------------------------ */
const LAB_PLACEHOLDERS = new Set(['', '-', 'VALOR', 'SO', '*', 'N/A']);

function numLab(s) {
  const n = Number(String(s).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export function parseLab(valorLab) {
  const original = String(valorLab ?? '').trim();
  const v = original.toUpperCase();
  const base = { valores: null, modo: null, cie10: null, texto: null, min: null, max: null, minIncl: null, maxIncl: null };
  if (LAB_PLACEHOLDERS.has(v)) return base;

  // "NUMERO", "NUMERICO", "CANTIDAD": exige un valor numerico, sin rango.
  if (/^(N[UÚ]MERO|NUM[EÉ]RICO|CANTIDAD)$/.test(v)) {
    return { ...base, modo: 'NUMERO', texto: 'NUMERO' };
  }

  // Operadores: >=10, >125, <5, <=88, =30
  let m = v.match(/^(>=|=>|>|<=|=<|<)\s*(-?\d+(?:[.,]\d+)?)$/);
  if (m) {
    const op = m[1];
    const n = numLab(m[2]);
    if (n === null) return base;
    const r = { ...base, modo: 'RANGO', texto: original };
    if (op === '>' || op === '>=' || op === '=>') {
      r.min = n;
      r.minIncl = op !== '>';
    } else {
      r.max = n;
      r.maxIncl = op !== '<';
    }
    return r;
  }

  // Rangos: 70-99, 5 a 9, 20 al 29
  m = v.match(/^(-?\d+(?:[.,]\d+)?)\s*(?:-|A|AL)\s*(-?\d+(?:[.,]\d+)?)$/);
  if (m) {
    const min = numLab(m[1]);
    const max = numLab(m[2]);
    if (min !== null && max !== null) {
      return { ...base, modo: 'RANGO', texto: original, min, max, minIncl: true, maxIncl: true };
    }
  }

  const multi = v
    .split(/\s*,\s*|\s+O\s+|\s+Ó\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const limpios = multi.filter((s) => s && !LAB_PLACEHOLDERS.has(s));

  if (limpios.length > 1) return { ...base, valores: limpios, modo: 'EN', texto: original };

  const unico = limpios[0];
  if (!unico) return base;

  // Un valor con forma de CIE10 es un error de extraccion: se trata como diagnostico.
  if (/^[A-Z][0-9]{2}/.test(unico) && !/^[DE][0-9]{4}$/.test(unico)) {
    return { ...base, cie10: unico };
  }

  return { ...base, valores: [unico], modo: 'IGUAL', texto: original };
}

/* Tipo de diagnostico ---------------------------------------------------- */
export function parseTipoDx(tipoDx) {
  const t = String(tipoDx || '').toUpperCase();
  // Conjuntos: "D,R", "D O R", "D Y R"
  const set = new Set();
  const re = /\b([DPR])\b/g;
  let m;
  while ((m = re.exec(t))) set.add(m[1]);
  if (set.size) return [...set].join(',');
  if (t.includes('DEFINITIVO')) return 'D';
  if (t.includes('PRESUNTIVO')) return 'P';
  if (t.includes('REITERATIVO') || t.includes('REPETID')) return 'R';
  return null;
}

/* Gestante --------------------------------------------------------------- */
export function parseGestante(texto) {
  const upper = String(texto || '').toUpperCase();
  const menciona = /\bGESTANTE\b/.test(upper) || /\bGESTACI[OÓ]N\b/.test(upper);
  const solo =
    /CUALQUIER_LAB\s*=\s*G\b/.test(upper) ||
    /\bSOLO GESTANTE/.test(upper) ||
    (menciona && !/NO\s+GESTANTE/.test(upper));
  const excluir = /CUALQUIER_LAB\s*<>|NO\s+GESTANTE/.test(upper);
  return { solo, excluir: !solo && excluir };
}

/* Sexo ------------------------------------------------------------------- */
export function parseSexo(texto) {
  const t = String(texto || '').toUpperCase();
  if (/NO GESTANTE|CUALQUIER_LAB\s*<>/.test(t)) return 'Ambos';
  if (/GESTANTE|MUJER|FEMENINO/.test(t)) return 'Femenino';
  if (/HOMBRE|MASCULINO/.test(t)) return 'Masculino';
  return 'Ambos';
}

/* Financiador ------------------------------------------------------------ */
export function parseFinanciador(texto, estrategiaCodigo) {
  const m = String(texto || '').match(/ID_FINANCIADOR\s*=\s*(\d+)/i);
  if (m) return m[1];
  // El script de referencia MINSA supervisa Salud Bucal sobre SIS (Id_Financiador = 2).
  if (estrategiaCodigo === 'SALUD_BUCAL') return '2';
  return null;
}

/* Textos descriptivos ---------------------------------------------------- */
export function parseFuente(estrategia, texto) {
  if (String(estrategia || '').toUpperCase().includes('SINTAXIS')) return 'Sintaxis PPR';
  if (/SINTAXIS|PPR/i.test(String(texto || ''))) return 'Sintaxis PPR';
  return 'Operacional';
}

export function inferirProceso(texto) {
  const t = String(texto || '').toLowerCase();
  if (/telemonitoreo|teleorientaci|teleinterconsulta|telesalud/.test(t)) return 'Teleatención';
  if (/tamizaje|detecci/.test(t)) return 'Tamizaje';
  if (/preventiv|sellante|fluor|profilaxis|asesor[ií]a|higiene/.test(t)) return 'Preventiva';
  if (/recuperativ|restauraci|exodoncia|endodoncia|cirug|debridaci/.test(t)) return 'Recuperativa';
  if (/especializ|máxilo|maxilo|ortodoncia|periodoncia|implante/.test(t)) return 'Especializada';
  if (/control|seguimiento|monitoreo/.test(t)) return 'Control';
  if (/tratamiento|terapia/.test(t)) return 'Tratamiento';
  if (/diagn[oó]stico|evaluaci|examen/.test(t)) return 'Diagnóstico';
  if (/referencia|contrarreferencia/.test(t)) return 'Referencia';
  if (/consejer|educaci/.test(t)) return 'Consejería';
  return 'Atención';
}

export function inferirUnidad(texto, subproducto) {
  const t = `${texto || ''} ${subproducto || ''}`.toLowerCase();
  // "Sumar_ valor lab", "Sumar_ lab", "Sumar el numero ... campo LAB", "piezas" => SUM(valor_lab)
  if (/sumar/.test(t) && /lab|pieza/.test(t)) return 'SUMA_LAB';
  if (/piezas/.test(t)) return 'SUMA_LAB';
  if (/caso\s+tratado/.test(t)) return 'CASO_TRATADO';
  if (/\bcasos?\b/.test(t)) return 'CASO';
  if (/persona/.test(t)) return 'PERSONA';
  if (/procedimiento/.test(t)) return 'PROCEDIMIENTO';
  if (/normal\s*\/?\s*alt/.test(t)) return 'NORMAL_ALT';
  if (/n[uú]mero/.test(t)) return 'NUMERO';
  return 'ATENCION';
}

export function parseSubproducto(raw) {
  const text = String(raw || '').trim();
  const m = text.match(/^([0-9A-Z]{4,10})\s+(.*)$/);
  if (m) return { codigo: m[1], nombre: m[2].trim() };
  return { codigo: null, nombre: text };
}

export function mapEstrategia(nombre) {
  const n = String(nombre || '').toLowerCase();
  if (n.includes('bucal')) return 'SALUD_BUCAL';
  if (n.includes('ocular')) return 'SALUD_OCULAR';
  // Consolidado: diabetes e hipertension son No Transmisible.
  if (n.includes('diabet') || n.includes('hiperten')) return 'NO_TRANSMISIBLE';
  if (n.includes('metal')) return 'METALES_PESADOS';
  if (n.includes('promsa') || n.includes('entornos saludables') || n.includes('vigilancia ciudadana')) {
    return 'PROMSA';
  }
  if (n.includes('no transmisible') || n.includes('no_transmisible') || n.includes('no transmisibles')) {
    return 'NO_TRANSMISIBLE';
  }
  if (n.startsWith('salud_bucal') || n === 'salud_bucal') return 'SALUD_BUCAL';
  if (n.startsWith('salud_ocular')) return 'SALUD_OCULAR';
  if (n.startsWith('no_transmisible')) return 'NO_TRANSMISIBLE';
  if (n.startsWith('promsa')) return 'PROMSA';
  if (n.startsWith('metales')) return 'METALES_PESADOS';
  if (n.startsWith('otras')) return 'NO_TRANSMISIBLE';
  return 'NO_TRANSMISIBLE';
}

/* Codigos requeridos ("con") --------------------------------------------- */
/**
 * Acepta dos formatos:
 *  1) Estructurado:  item.requeridos = [{ codigos: ["E780", "E781"] }, { codigo: "99199.22" }]
 *     Cada elemento del arreglo es un grupo: dentro del grupo se cumple con CUALQUIERA,
 *     entre grupos se exigen TODOS.
 *  2) Texto (UI):    item.codigos_requeridos = "E780,E781|99199.22"
 *     "|" separa grupos, "," separa alternativas, "CODIGO:LAB" fija el laboratorio.
 */
export function parseRequeridos(item) {
  const salida = [];
  const vistos = new Set();
  const agregar = (grupo, codigo, valorLab, tipoDx) => {
    const code = String(codigo || '').trim();
    if (!code) return;
    const lab = valorLab === undefined || valorLab === null || valorLab === ''
      ? null
      : String(valorLab).trim().toUpperCase();
    const td = tipoDx ? parseTipoDx(tipoDx) : null;
    const key = `${grupo}|${code}|${lab || ''}|${td || ''}`;
    if (vistos.has(key)) return;
    vistos.add(key);
    salida.push({ grupo, codigo: code, tipo: clasificarCodigo(code), valor_lab: lab, tipo_dx: td });
  };

  if (Array.isArray(item.requeridos)) {
    item.requeridos.forEach((g, idx) => {
      const grupo = idx + 1;
      if (typeof g === 'string') {
        agregar(grupo, g);
        return;
      }
      if (Array.isArray(g?.codigos)) {
        for (const c of g.codigos) {
          if (typeof c === 'string') agregar(grupo, c);
          else agregar(grupo, c?.codigo, c?.valor_lab, c?.tipo_dx);
        }
      } else if (g?.codigo) {
        agregar(grupo, g.codigo, g.valor_lab, g.tipo_dx);
      }
    });
  }

  if (item.codigos_requeridos) {
    const base = salida.length ? Math.max(...salida.map((r) => r.grupo)) : 0;
    String(item.codigos_requeridos)
      .split('|')
      .forEach((parte, idx) => {
        const grupo = base + idx + 1;
        parte.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((token) => {
            const [codigo, lab, td] = token.split(':');
            agregar(grupo, codigo, lab, td);
          });
      });
  }

  return salida;
}

/* Codigos ---------------------------------------------------------------- */
export function normalizarCodigos(item) {
  const texto = `${item.regla_original || ''} ${item.subproducto || ''}`;
  const raw = String(item.codigos || '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

  const inclusiones = [];
  const exclusiones = [];
  const vistos = new Set();

  for (const original of raw) {
    if (original === '99499.' || original === '99499') {
      // comodin mal formado: se expande al rango estandar de exclusion
      for (let i = 1; i <= 20; i++) {
        const c = `99499.${String(i).padStart(2, '0')}`;
        if (!vistos.has(c)) { vistos.add(c); exclusiones.push(c); }
      }
      continue;
    }

    const tipo = clasificarCodigo(original);
    const esObjetivo = new RegExp(
      `(?:DX|COD_ITEM_CPMS|COD_CPMS)\\s*=\\s*${original.replace(/\./g, '\\.')}\\b`,
      'i'
    ).test(texto);

    if (esCodigoExclusion(original) && !esObjetivo) {
      if (!vistos.has(original)) { vistos.add(original); exclusiones.push(original); }
    } else if (!vistos.has(original)) {
      vistos.add(original);
      inclusiones.push({ code: original, tipo, esObjetivo });
    }
  }
  return { inclusiones, exclusiones };
}

/**
 * Normaliza una regla completa (JSON crudo o formulario).
 * `estrategiaCodigo` debe ser SALUD_BUCAL | SALUD_OCULAR | NO_TRANSMISIBLE | PROMSA | METALES_PESADOS.
 */
export function normalizarRegla(item, estrategiaCodigo) {
  const sub = parseSubproducto(item.subproducto);
  const unidadCodigo = item.unidad_medida
    ? mapUnidad(item.unidad_medida)
    : inferirUnidad(item.regla_original, item.subproducto);

  const edad = parseEdadMeses(item.rango_edad);
  const lab = parseLab(item.valor_lab);
  const gest = parseGestante(`${item.subproducto} ${item.restriccion || ''} ${item.regla_original || ''}`);
  const tipoDx = parseTipoDx(item.tipo_dx);
  const financiador = parseFinanciador(item.regla_original, estrategiaCodigo);
  const sexo = parseSexo(`${item.subproducto} ${item.restriccion || ''} ${item.regla_original || ''}`);
  const fuente = item.fuente || parseFuente(item.estrategia, item.regla_original);
  const proceso = item.proceso || inferirProceso(`${item.subproducto} ${item.regla_original || ''}`);
  const { inclusiones, exclusiones } = normalizarCodigos(item);
  const requeridos = parseRequeridos(item);

  if (lab.cie10 && !inclusiones.some((i) => i.code === lab.cie10)) {
    inclusiones.push({ code: lab.cie10, tipo: 'CIE10', esObjetivo: true });
  }

  const ups = String(item.id_ups || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .join(',');

  const pabOp = ['<=', '>'].includes(String(item.pab_op || '').trim()) ? String(item.pab_op).trim() : null;
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };

  return {
    subproducto: { codigo: sub.codigo, nombre: sub.nombre, unidadCodigo },
    fuente,
    proceso,
    tipo_dx: tipoDx,
    valor_lab: lab.valores ? lab.valores.join(',') : (lab.texto || null),
    lab_modo: lab.modo,
    lab_min: lab.min,
    lab_max: lab.max,
    lab_min_incl: lab.minIncl === null ? null : (lab.minIncl ? 1 : 0),
    lab_max_incl: lab.maxIncl === null ? null : (lab.maxIncl ? 1 : 0),
    edad_min_meses: edad.min,
    edad_max_meses: edad.max,
    condicion_sexo: sexo,
    solo_gestante: gest.solo ? 1 : 0,
    excluir_gestante: gest.excluir ? 1 : 0,
    id_financiador: financiador,
    id_ups: ups || null,
    pab_op: pabOp,
    pab_femenino: pabOp ? num(item.pab_femenino) : null,
    pab_masculino: pabOp ? num(item.pab_masculino) : null,
    restriccion: item.restriccion && item.restriccion !== '-' ? item.restriccion : null,
    nivel_restriccion: item.nivel_restriccion && item.nivel_restriccion !== '-' ? item.nivel_restriccion : null,
    regla_original: item.regla_original || null,
    inclusiones,
    exclusiones,
    requeridos
  };
}

/** Traduce el nombre de unidad que muestra la UI al codigo interno. */
export function mapUnidad(nombre) {
  const n = String(nombre || '').toLowerCase().trim();
  if (n.includes('sumar') || n.includes('pieza')) return 'SUMA_LAB';
  if (n.includes('caso tratado')) return 'CASO_TRATADO';
  if (n === 'caso' || n.startsWith('caso')) return 'CASO';
  if (n.includes('persona')) return 'PERSONA';
  if (n.includes('procedimiento')) return 'PROCEDIMIENTO';
  if (n.includes('normal')) return 'NORMAL_ALT';
  if (n.includes('número') || n.includes('numero')) return 'NUMERO';
  return 'ATENCION';
}

/** Nombre visible de la unidad a partir del codigo interno. */
export function nombreUnidad(codigo) {
  switch (codigo) {
    case 'PERSONA': return 'Persona';
    case 'CASO': return 'Caso';
    case 'CASO_TRATADO': return 'Caso Tratado';
    case 'SUMA_LAB': return 'Sumar Lab (Piezas)';
    case 'PROCEDIMIENTO': return 'Procedimiento';
    case 'NORMAL_ALT': return 'Normal/Alt';
    case 'NUMERO': return 'Número';
    default: return 'Atención';
  }
}
