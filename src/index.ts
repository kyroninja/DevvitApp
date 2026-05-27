import { Hono } from 'hono';
import { serve } from '@hono/node-server';

import { createServer, getServerPort } from '@devvit/web/server';

import { api } from './routes/api';
import { forms } from './routes/forms';
import { menu } from './routes/menu';
import { triggers } from './routes/triggers';

/**
 * ─────────────────────────────────────────────
 * MAIN APP
 * ─────────────────────────────────────────────
 */
const app = new Hono();

/**
 * ─────────────────────────────────────────────
 * INTERNAL ROUTES
 * ─────────────────────────────────────────────
 */
const internal = new Hono();

internal.route('/menu', menu);
internal.route('/form', forms);
internal.route('/triggers', triggers);

/**
 * ─────────────────────────────────────────────
 * PUBLIC ROUTES
 * ─────────────────────────────────────────────
 */
app.route('/api', api);

/**
 * ─────────────────────────────────────────────
 * MOUNT INTERNAL ROUTES
 * ─────────────────────────────────────────────
 */
app.route('/internal', internal);

/**
 * ─────────────────────────────────────────────
 * HEALTHCHECK
 * (helps diagnose Devvit routing failures)
 * ─────────────────────────────────────────────
 */
app.get('/', (c) => {
  return c.text('BrandPulse server running');
});

/**
 * ─────────────────────────────────────────────
 * DEVVIT SERVER BOOTSTRAP
 * IMPORTANT:
 * Use serve() + createServer together
 * ─────────────────────────────────────────────
 */
serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});