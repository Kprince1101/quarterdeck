import { writeFileSync } from 'node:fs';

const marker = process.env['QUARTERDECK_CWD_MARKER'];
if (marker) writeFileSync(marker, process.cwd());

await import('../fake-agent/main.ts');
