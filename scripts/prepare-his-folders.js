import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';

const root = process.env.HIS_ROOT || 'D:\\HISMINSA';
const folders = [
  path.join(root, 'MAESTROS', 'MaestrosHIS'),
  path.join(root, 'MAESTROS', 'HIS'),
  path.join(root, 'MAESTROS', 'Dorado'),
  path.join(root, 'MAESTROS', 'Lamas'),
  path.join(root, 'MAESTROS', 'Picota'),
  path.join(root, 'MAESTROS', 'SanMartin'),
];

for (const folder of folders) {
  await fs.mkdir(folder, { recursive: true });
  console.log(`OK ${folder}`);
}

console.log('\nEstructura lista. Copia allí los CSV de maestros y las tramas nominales antes de importar.');
