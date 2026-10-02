import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppProps } from './App.js';
import './theme/tokens.css';
import './shell/shell.css';
import './grid/grid.css';
import './layouts/layouts.css';
import './widgets/widgets.css';

export const mountPage = (page: ReactNode): void => {
  const container = document.getElementById('root');
  if (container === null) throw new Error('index.html has no #root');

  createRoot(container).render(<StrictMode>{page}</StrictMode>);
};

export const mountApp = (props: AppProps = {}): void => {
  mountPage(<App {...props} />);
};
