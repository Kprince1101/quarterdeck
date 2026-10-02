export type ItemKey = string | number;

export interface TabSpec {
  id: string;
  label: string;
  newest: ItemKey | null;
}

export type SeenKeys = Readonly<Record<string, ItemKey | null>>;

type TabStep = (index: number, count: number) => number;

const TAB_STEPS: Record<string, TabStep> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export const resolveActiveTab = (
  tabs: readonly TabSpec[],
  selected: string | null,
): string | null => {
  if (tabs.some(({ id }) => id === selected)) return selected;
  return tabs[0]?.id ?? null;
};

export const tabAfterKey = (
  tabs: readonly TabSpec[],
  current: string | null,
  key: string,
): string | null => {
  const step = TAB_STEPS[key];
  const index = tabs.findIndex(({ id }) => id === current);
  if (step === undefined || index === -1) return null;
  return tabs[step(index, tabs.length)]?.id ?? null;
};

export const seenKeysOf = (tabs: readonly TabSpec[]): SeenKeys =>
  Object.fromEntries(tabs.map(({ id, newest }) => [id, newest]));

export const markSeenKey = (
  seen: SeenKeys | null,
  id: string,
  key: ItemKey,
): SeenKeys | null => {
  if (seen === null || seen[id] === key) return seen;
  return { ...seen, [id]: key };
};

export const isUnread = (tab: TabSpec, seen: SeenKeys | null): boolean => {
  if (seen === null || tab.newest === null) return false;
  return (seen[tab.id] ?? null) !== tab.newest;
};

export const tabIndexOf = (isActive: boolean): number => {
  if (isActive) return 0;
  return -1;
};

export const controlsOf = (
  isActive: boolean,
  panelId: string,
): string | undefined => {
  if (isActive) return panelId;
  return undefined;
};

export const tabDomId = (prefix: string, id: string): string =>
  `${prefix}-tab-${id}`;

export const panelDomId = (prefix: string, id: string): string =>
  `${prefix}-panel-${id}`;
