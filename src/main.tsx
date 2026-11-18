/**
 * Punto de entrada del árbol React de SB-Finance.
 *
 * Arquitectura y decisiones técnicas:
 * - Importa `index.css` una única vez en el nivel raíz para cargar los tokens de
 *   Tailwind v4 y tipografía tabular antes de montar `<App />`.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('No se encontró el nodo #root en index.html.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
