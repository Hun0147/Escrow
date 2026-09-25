import { startWorkers } from './worker';

/** Standalone worker process: `npm run worker --workspace=apps/api`. */
startWorkers();
console.log('Goal 27 worker started (OCR queue + reporting-deadline sweep)');
