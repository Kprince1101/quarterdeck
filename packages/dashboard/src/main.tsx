import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './theme/tokens.css';
import './shell/shell.css';
import './grid/grid.css';
import './widgets/widgets.css';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html has no #root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
