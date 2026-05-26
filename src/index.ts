import { Hono } from 'hono';
import { createServer, getServerPort } from '@devvit/web/server';

import { api } from './routes/api';
import { forms } from './routes/forms';
import { menu } from './routes/menu';
import { triggers } from './routes/triggers';

/**
 * ─────────────────────────────────────────────
 * MAIN APP ROUTER
 * ─────────────────────────────────────────────
 */
const app = new Hono();

/**
 * ─────────────────────────────────────────────
 * INTERNAL DEVVIT ROUTES
 * (triggered by Reddit events + mod UI actions)
 * ─────────────────────────────────────────────
 */
const internal = new Hono();

internal.route('/menu', menu);
internal.route('/form', forms);
internal.route('/triggers', triggers);

/**
 * ─────────────────────────────────────────────
 * PUBLIC API ROUTES
 * (optional external/debug endpoints)
 * ─────────────────────────────────────────────
 */
app.route('/api', api);

/**
 * ─────────────────────────────────────────────
 * MOUNT INTERNAL SYSTEM
 * ─────────────────────────────────────────────
 */
app.route('/internal', internal);

/**
 * ─────────────────────────────────────────────
 * DEVVIT HTTP SERVER BOOTSTRAP
 * IMPORTANT: Devvit runs this as a handler, not a Node server
 * ─────────────────────────────────────────────
 */
export default createServer({
  fetch: app.fetch,
  port: getServerPort(),
});