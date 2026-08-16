import { access, readFile } from 'node:fs/promises';

const required = [
  'public/index.html',
  'public/assets/index.css',
  'netlify/functions/search.mjs',
  'netlify.toml'
];

for (const file of required) await access(file);
const html = await readFile('public/index.html', 'utf8');
if (!html.includes('/#/inquiries/slenquiry') || !html.includes('/api/search')) {
  throw new Error('Expected inquiry route/API endpoint not found in public/index.html');
}
console.log('Build check passed.');
