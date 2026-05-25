import { fileURLToPath } from 'node:url';
import node from '@astrojs/node';
import vercel from '@astrojs/vercel';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const isVercel = !!process.env.VERCEL;

export default defineConfig({
  output: 'server',
  site: process.env.PUBLIC_SITE_URL ?? 'https://mnema.theboringpeople.in',
  // Use @astrojs/vercel when building on Vercel; fall back to standalone
  // Node.js server for local dev and manual builds.
  adapter: isVercel ? vercel() : node({ mode: 'standalone' }),
  integrations: [react(), sitemap()],
  server: { port: 5173 },
  vite: {
    envDir: repoRoot,
    plugins: [tailwindcss()],
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:8080',
          changeOrigin: true,
        },
      },
    },
  },
});

