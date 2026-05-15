import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import Fastify from 'fastify';
import { config } from './config/env.js';
import { mcpPlugin } from './mcp/plugin.js';
import { authPlugin } from './plugins/auth.js';
import { loggerOptions } from './plugins/logger.js';
import { authRoutes } from './routes/auth.js';
import { docsRoutes } from './routes/docs.js';
import { healthRoutes } from './routes/health.js';
import { setSessionRoutes } from './routes/_internal/set-session.js';

const app = Fastify({ logger: loggerOptions });

await app.register(helmet, { contentSecurityPolicy: false });
await app.register(cors, {
  // 5173 = web app (Astro). 6274 = MCP Inspector default UI.
  // Phase 2.1: the MCP Inspector hits POST /mcp from the browser context.
  origin: ['http://localhost:5173', 'http://localhost:6274'],
  credentials: true,
});
await app.register(sensible);
await app.register(authPlugin);
await app.register(healthRoutes);
await app.register(setSessionRoutes);
await app.register(authRoutes);
await app.register(docsRoutes);
await app.register(mcpPlugin);

const port = config.API_PORT;
try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`API listening on http://localhost:${port}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info(`${signal} received, shutting down...`);
  await app.close();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
