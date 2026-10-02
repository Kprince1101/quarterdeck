import { writeFileSync } from 'node:fs';

if (process.argv.includes('--version')) {
  process.stdout.write('env-fixture 0.0.0\n');
  process.exit(0);
}

const marker = process.env['QUARTERDECK_ENV_MARKER'];
if (marker) writeFileSync(marker, JSON.stringify(process.env));

await import('../fake-agent/main.ts');
