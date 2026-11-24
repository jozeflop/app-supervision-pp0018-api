import { query, closePool } from '../db.js';

const sample = await query(`
  SELECT id_regla, codigo_origen, estrategia, subproducto, unidad_medida, tipo_agregacion,
         tipo_dx, valor_lab, lab_modo, edad_min_meses, edad_max_meses, condicion_sexo,
         solo_gestante, excluir_gestante, id_financiador, codigos_inclusion, codigos_exclusion
  FROM dbo.vw_ReglasCompletas
  WHERE codigo_origen IN ('rule_9','rule_15','rule_142','rule_150','rule_40','rule_7')
  ORDER BY id_regla LIMIT 12`);

for (const r of sample) {
  console.log('---', r.codigo_origen, '|', r.estrategia, '|', r.unidad_medida, r.tipo_agregacion);
  console.log('  sub:', String(r.subproducto).slice(0, 70));
  console.log('  dx=', r.tipo_dx, 'lab=', r.valor_lab, r.lab_modo, 'edad=', r.edad_min_meses, r.edad_max_meses, 'sexo=', r.condicion_sexo, 'gest=', r.solo_gestante, r.excluir_gestante, 'fin=', r.id_financiador);
  console.log('  incl:', String(r.codigos_inclusion).slice(0, 120));
  console.log('  excl:', String(r.codigos_exclusion || '').slice(0, 80));
}

console.log('\n=== Totales ===');
console.log(await query('SELECT COUNT(*) n FROM dbo.Reglas'));
console.log(await query('SELECT tipo_codigo, es_exclusion, COUNT(*) n FROM dbo.ReglaCodigos GROUP BY tipo_codigo, es_exclusion'));

console.log('\n=== Unidades ===');
for (const r of await query(`
  SELECT u.nombre, u.tipo_agregacion, COUNT(*) n
  FROM dbo.Reglas r JOIN dbo.Subproductos s ON s.id_subproducto=r.id_subproducto
  JOIN dbo.UnidadesMedida u ON u.id_unidad=s.id_unidad
  GROUP BY u.nombre, u.tipo_agregacion ORDER BY n DESC`)) {
  console.log(`  ${String(r.nombre).padEnd(22)} ${String(r.tipo_agregacion).padEnd(12)} ${r.n}`);
}

console.log('\n=== Gestante / edad ===');
console.log(await query('SELECT solo_gestante, excluir_gestante, COUNT(*) n FROM dbo.Reglas GROUP BY solo_gestante, excluir_gestante'));
console.log(await query('SELECT COUNT(*) con_edad FROM dbo.Reglas WHERE edad_min_meses IS NOT NULL OR edad_max_meses IS NOT NULL'));

await closePool();
process.exit(0);
