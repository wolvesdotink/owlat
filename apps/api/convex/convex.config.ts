import { defineApp } from 'convex/server';
import betterAuth from './betterAuth/convex.config';
import rateLimiter from '@convex-dev/rate-limiter/convex.config';
import workpool from '@convex-dev/workpool/convex.config';

const app = defineApp();
app.use(betterAuth);
app.use(rateLimiter);

// Email workpools for rate-limited sending
// Two pools with different priorities:
// - transactionalEmailPool: Higher parallelism (30/sec) for time-sensitive emails
// - campaignEmailPool: Lower parallelism (20/sec) for bulk marketing
app.use(workpool, { name: 'transactionalEmailPool' });
app.use(workpool, { name: 'campaignEmailPool' });

// Saved-block rerender pool (ADR-0023). Reactively re-renders consumer
// `htmlContent` after a saved block's content changes. Lower parallelism than
// send pools — these batches re-render a small set of templates per job.
app.use(workpool, { name: 'rerenderBlocksPool' });

export default app;
