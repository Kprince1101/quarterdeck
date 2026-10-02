export const TOKEN_PARAM = 'token';

export const TOKEN_STORAGE_KEY = 'quarterdeck.token';

export interface TokenPage {
  location: { hash: string; pathname: string; search: string };
  history: Pick<History, 'state' | 'replaceState'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

const withoutToken = (
  { pathname, search }: TokenPage['location'],
  fragment: URLSearchParams,
): string => {
  fragment.delete(TOKEN_PARAM);
  const rest = fragment.toString();
  if (rest === '') return `${pathname}${search}`;
  return `${pathname}${search}#${rest}`;
};

export const takePageToken = (
  page: TokenPage = globalThis as unknown as TokenPage,
): string | null => {
  const fragment = new URLSearchParams(page.location.hash.slice(1));
  const token = fragment.get(TOKEN_PARAM);
  if (token !== null) {
    if (token !== '') page.sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    page.history.replaceState(
      page.history.state,
      '',
      withoutToken(page.location, fragment),
    );
  }
  return page.sessionStorage.getItem(TOKEN_STORAGE_KEY);
};
