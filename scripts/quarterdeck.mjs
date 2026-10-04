import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const bin = join(
  import.meta.dirname,
  '..',
  'packages',
  'cli',
  'dist',
  'bin.js',
);

if (!existsSync(bin)) {
  process.stderr.write(
    'Quarterdeck is not built. Run npm install in the clone (it builds every package), then try again.\n',
  );
  process.exit(1);
}
const folderNpmRanIn = process.env.INIT_CWD;
if (folderNpmRanIn) process.chdir(folderNpmRanIn);
await import(pathToFileURL(bin).href);
