import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--version')) {
  process.stdout.write('gemini-fixture 0.0.0\n');
  process.exit(0);
}

const marker = process.env['QUARTERDECK_ENV_MARKER'];
if (marker) {
  writeFileSync(
    marker,
    JSON.stringify({
      cwd: process.cwd(),
      args,
      systemSettings: process.env['GEMINI_CLI_SYSTEM_SETTINGS_PATH'],
      trustWorkspace: process.env['GEMINI_CLI_TRUST_WORKSPACE'],
    }),
  );
}

await import('../fake-agent/main.ts');
