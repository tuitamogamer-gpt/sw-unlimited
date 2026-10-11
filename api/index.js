import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { authApp, isAuthRequest } = require('../server/auth.cjs');

export default async function handler(req, res) {
  // Sign-in and account reads do not depend on the rules engine or card catalog.
  if (isAuthRequest(req.url)) return authApp(req, res);
  try {
    const { app, initialize } = require('../server/index.cjs');
    await initialize();
    return app(req, res);
  } catch (error) {
    console.error('SWU initialization failed:', error.message);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.end(JSON.stringify({ error: 'The game server is currently unavailable. Try again.' }));
  }
}
