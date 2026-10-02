import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';

export interface VercelConfig {
  framework?: string | null;
  installCommand?: string;
  buildCommand?: string;
  outputDirectory?: string;
}

export const SITE = resolve(import.meta.dirname, '..');
export const ROOT = resolve(SITE, '..');
export const vercel = JSON.parse(
  readFileSync(resolve(SITE, 'vercel.json'), 'utf8'),
) as VercelConfig;
export const PUBLIC = resolve(SITE, 'public');
export const OUT = resolve(SITE, vercel.outputDirectory ?? '');

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
export const TEXT_EXTENSIONS = ['.html', '.css', '.svg'];

export const publicFiles = readdirSync(PUBLIC, {
  recursive: true,
  encoding: 'utf8',
})
  .map((path) => resolve(PUBLIC, path))
  .filter((path) => statSync(path).isFile())
  .filter((path) => TEXT_EXTENSIONS.includes(extname(path)));

export const htmlPages = publicFiles
  .filter((path) => extname(path) === '.html')
  .map((path) => relative(PUBLIC, path));

export const readPage = (page: string): string =>
  readFileSync(resolve(PUBLIC, page), 'utf8');

const SHOWN_NOT_LOADED_CODE_TEXT = /<code>[^<]*<\/code>/g;

export const crossOriginUrls = (source: string): string[] =>
  source
    .replaceAll(SVG_NAMESPACE, '')
    .replaceAll(SHOWN_NOT_LOADED_CODE_TEXT, '<code></code>')
    .match(/(https?:)?\/\/[^\s'"()<>]*/g) ?? [];

export const attributeValues = (html: string, name: string): string[] =>
  [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(
    (match) => match[1] ?? '',
  );

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  ldquo: '“',
  rdquo: '”',
  copy: '©',
};

const decode = (text: string): string =>
  text.replaceAll(/&(\w+);/g, (entity, name: string) => {
    const decoded = ENTITIES[name];
    if (decoded === undefined) throw new Error(`Unknown entity ${entity}`);
    return decoded;
  });

export const pageText = (html: string): string =>
  decode(html.replaceAll(/<[^>]+>/g, ' ')).replaceAll(/\s+/g, ' ');

export const codeBlocks = (html: string): string[] =>
  [...html.matchAll(/<pre><code>([^<]*)<\/code><\/pre>/g)].map((match) =>
    decode(match[1] ?? ''),
  );

export const headings = (html: string, level: number): string[] =>
  [...html.matchAll(new RegExp(`<h${level}[^>]*>(.*?)</h${level}>`, 'gs'))].map(
    (match) => pageText(match[1] ?? '').trim(),
  );

export const ids = (html: string): string[] => attributeValues(html, 'id');

export interface Link {
  page: string;
  url: string;
  file: string;
  fragment: string | undefined;
}

const linkTarget = (page: string, path: string): string => {
  if (path === '') return resolve(OUT, page);
  const target = resolve(OUT, dirname(page), path);
  if (path.endsWith('/')) return resolve(target, 'index.html');
  return target;
};

export const localLinks = (page: string): Link[] => {
  const html = readPage(page);
  return [
    ...attributeValues(html, 'href'),
    ...attributeValues(html, 'src'),
  ].map((url) => {
    const [path = '', fragment] = url.split('#');
    return { page, url, file: linkTarget(page, path), fragment };
  });
};
