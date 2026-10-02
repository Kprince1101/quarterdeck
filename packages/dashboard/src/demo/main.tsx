import { mountApp } from '../mount.js';
import { createDemoServer } from './demo-server.js';

export const DEMO_MODE = 'Demo';

const server = createDemoServer();

mountApp({ mode: DEMO_MODE, ...server.sources });
server.start();
