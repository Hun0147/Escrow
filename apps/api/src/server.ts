import { createServer } from 'http';
import { createApp } from './app';
import { attachRealtime } from './realtime/gateway';
import { startWorkers } from './queue/worker';

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;

const server = createServer(createApp());
attachRealtime(server);

// One process runs the API and the background jobs in development. In
// production these are separate deployments off the same image; set
// WORKERS=off on the web dynos.
if (process.env.WORKERS !== 'off') startWorkers();

server.listen(PORT, () => {
  console.log(`Goal 27 API listening on port ${PORT}`);
});
