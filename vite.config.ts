/**
 * Configuración de Vite para SB-Finance.
 *
 * Arquitectura y decisiones técnicas:
 * - Usamos @vitejs/plugin-react junto con @tailwindcss/vite (Tailwind v4) para
 *   compilar CSS sin archivos tailwind.config.js heredados, manteniendo los tokens
 *   directamente en src/index.css mediante @theme y variables CSS nativas.
 * - Dividimos los vendors pesados (`recharts`, `@supabase/supabase-js`, `react`)
 *   mediante `manualChunks` para optimizar caché del navegador y eliminar chunks > 500 kB.
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;

          if (
            id.includes('recharts') ||
            id.includes('d3-') ||
            id.includes('victory-vendor')
          ) {
            return 'vendor-recharts';
          }

          if (id.includes('@supabase')) {
            return 'vendor-supabase';
          }

          if (
            id.includes('react-dom') ||
            id.includes('react-router') ||
            id.includes('/react/') ||
            id.includes('\\react\\')
          ) {
            return 'vendor-react';
          }
        },
      },
    },
  },
});
