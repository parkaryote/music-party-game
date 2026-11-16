import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server } from 'socket.io';
import { attachGame } from './game.js';

const app = express();
app.disable('x-powered-by');

const httpServer = createServer(app);

// The client is served from this same origin (or through the Vite dev proxy), so
// cross-origin access is off unless CLIENT_ORIGIN lists the allowed origins.
const allowedOrigins = (process.env.CLIENT_ORIGIN ?? '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const io = new Server(httpServer, {
  cors: allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined,
  maxHttpBufferSize: 64 * 1024
});

const game = attachGame(io);

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: game.roomCount() });
});

// Built layout: dist/server/server/index.js next to dist/client.
const clientDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client');
if (existsSync(path.join(clientDist, 'index.html'))) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

const port = Number(process.env.PORT || 3000);
httpServer.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});
