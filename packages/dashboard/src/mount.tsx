import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type AppProps } from './app.js';
import './theme/tokens.css';
import './shell/shell.css';
import './grid/grid.css';
import './layouts/layouts.css';
import './widgets/widgets.css';

export const mountApp = (props: AppProps = {}): void => {
  const container = document.getElementById('root');
  if (container === null) throw new Error('index.html has no #root');

  createRoot(container).render(
    <StrictMode>
      <App {...props} />
    </StrictMode>,
  );
};
