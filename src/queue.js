// Shared job-queue setup, used by both processes:
//   - the web service (src/server.js) ADDS clip jobs to the queue
//   - the worker service (src/worker.js) CONSUMES them
// Both connect to the same Render Key Value (Redis) instance via REDIS_URL.
//
// Clipping can't happen inside a web request: downloading and cutting even a short section takes
// far longer than a request should ever hang, and the web service is a small free instance. So the
// request just drops a job on the queue and returns immediately, and the worker does the slow part.

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const QUEUE_NAME = 'clip-jobs';

// BullMQ requires maxRetriesPerRequest to be null on connections it uses (its blocking commands
// would otherwise be killed by ioredis's retry cap).
function createConnection() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return new IORedis(url, { maxRetriesPerRequest: null });
}

let queue = null;

// Returns null when REDIS_URL isn't configured, so callers can degrade gracefully with a clear
// message instead of crashing the whole service on boot.
function getQueue() {
  if (queue) return queue;
  const connection = createConnection();
  if (!connection) return null;
  queue = new Queue(QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 60 * 60 },
      removeOnFail: { age: 60 * 60 },
    },
  });
  return queue;
}

module.exports = { QUEUE_NAME, createConnection, getQueue };
