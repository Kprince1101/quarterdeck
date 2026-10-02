export type JsonObject = Record<string, unknown>;

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const mergeEntry = (base: JsonObject, layer: JsonObject, key: string) => {
  if (!Object.hasOwn(layer, key)) return base[key];
  return mergeLayer(base[key], layer[key]);
};

export const mergeLayer = (base: unknown, layer: unknown): unknown => {
  if (!isJsonObject(base) || !isJsonObject(layer)) return layer;
  const keys = new Set([...Object.keys(base), ...Object.keys(layer)]);
  return Object.fromEntries(
    [...keys].map((key) => [key, mergeEntry(base, layer, key)]),
  );
};
