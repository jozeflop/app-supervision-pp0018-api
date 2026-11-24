import fs from 'node:fs';

const rulesPath = process.argv[2] || process.env.RULES_JSON_PATH;
if (!rulesPath) throw new Error('Indica el archivo JSON con RULES_JSON_PATH o como primer argumento.');
const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));

const isCie = (c) => /^[A-Z]/.test(c);
const isProc = (c) => /^[0-9]/.test(c) || /^D[0-9]/.test(c);

const stats = { both: 0, onlyDx: 0, onlyProc: 0, none: 0 };
const samples = { both: [], onlyDx: [], onlyProc: [] };

for (const r of rules) {
  const codes = String(r.codigos || '').split(',').map(s => s.trim()).filter(Boolean);
  const dx = codes.filter(isCie);
  const proc = codes.filter(isProc);
  if (!codes.length) stats.none++;
  else if (dx.length && proc.length) { stats.both++; if (samples.both.length < 6) samples.both.push({ id: r.id, e: r.estrategia, dx, proc, rango: r.rango_edad, tipo: r.tipo_dx, lab: r.valor_lab, regla: (r.regla_original||'').slice(0,110) }); }
  else if (dx.length) { stats.onlyDx++; if (samples.onlyDx.length < 6) samples.onlyDx.push({ id: r.id, e: r.estrategia, dx, rango: r.rango_edad, tipo: r.tipo_dx, lab: r.valor_lab, regla: (r.regla_original||'').slice(0,110) }); }
  else { stats.onlyProc++; if (samples.onlyProc.length < 6) samples.onlyProc.push({ id: r.id, e: r.estrategia, proc, rango: r.rango_edad, tipo: r.tipo_dx, lab: r.valor_lab, regla: (r.regla_original||'').slice(0,110) }); }
}

console.log(JSON.stringify(stats, null, 1));
for (const k of Object.keys(samples)) {
  console.log('\n### ' + k);
  for (const s of samples[k]) console.log(JSON.stringify(s));
}

// distinct rango_edad values
const rangos = {};
rules.forEach(r => { const v = String(r.rango_edad || '-'); rangos[v] = (rangos[v] || 0) + 1; });
console.log('\n### rangos (' + Object.keys(rangos).length + ')');
Object.entries(rangos).sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v]) => console.log(v, '|', k));

const labs = {};
rules.forEach(r => { const v = String(r.valor_lab || '-'); labs[v] = (labs[v] || 0) + 1; });
console.log('\n### labs (' + Object.keys(labs).length + ')');
Object.entries(labs).sort((a,b)=>b[1]-a[1]).slice(0,25).forEach(([k,v]) => console.log(v, '|', k));

const tdx = {};
rules.forEach(r => { const v = String(r.tipo_dx || '-'); tdx[v] = (tdx[v] || 0) + 1; });
console.log('\n### tipo_dx');
console.log(JSON.stringify(tdx, null, 1));

const restr = {};
rules.forEach(r => { const v = String(r.restriccion || '-'); restr[v] = (restr[v] || 0) + 1; });
console.log('\n### restricciones (' + Object.keys(restr).length + ')');
Object.entries(restr).sort((a,b)=>b[1]-a[1]).slice(0,15).forEach(([k,v]) => console.log(v, '|', k));

