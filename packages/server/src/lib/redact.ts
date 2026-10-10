export const REDACTED = '[redacted]';

interface SecretShape {
  pattern: RegExp;
  replace: string;
}

const SECRET_SHAPES: readonly SecretShape[] = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: REDACTED,
  },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: REDACTED },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replace: REDACTED },
  { pattern: /\bsk-ant-[A-Za-z0-9_-]*/g, replace: REDACTED },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replace: REDACTED },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: REDACTED },
  {
    pattern: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s@/]+@/gi,
    replace: `$1${REDACTED}@`,
  },
];

const SECRET_ENV_NAME = /TOKEN|SECRET|KEY|PASSWORD|DATABASE_URL/i;

const MIN_SECRET_VALUE_LENGTH = 8;

export const secretEnvValues = (
  env: NodeJS.ProcessEnv = process.env,
): string[] =>
  Object.entries(env)
    .filter(([name]) => SECRET_ENV_NAME.test(name))
    .map(([, value]) => value ?? '')
    .filter((value) => value.length >= MIN_SECRET_VALUE_LENGTH)
    .toSorted((a, b) => b.length - a.length);

const redactWith = (text: string, values: readonly string[]): string => {
  const literal = values.reduce(
    (out, value) => out.replaceAll(value, REDACTED),
    text,
  );
  return SECRET_SHAPES.reduce(
    (out, { pattern, replace }) => out.replace(pattern, replace),
    literal,
  );
};

export const redactSecrets = (
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string => redactWith(text, secretEnvValues(env));

const redactDeep = (value: unknown, values: readonly string[]): unknown => {
  if (typeof value === 'string') return redactWith(value, values);
  if (Array.isArray(value))
    return value.map((item) => redactDeep(item, values));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDeep(item, values),
      ]),
    );
  }
  return value;
};

export const redactValue = <T>(
  value: T,
  env: NodeJS.ProcessEnv = process.env,
): T => redactDeep(value, secretEnvValues(env)) as T;

export const redactShapes = <T>(value: T): T => redactDeep(value, []) as T;
