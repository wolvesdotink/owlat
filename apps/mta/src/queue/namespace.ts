/**
 * The queue's Redis name, in a module that imports nothing.
 *
 * This lived in `queue/setup.ts`, which imports `routes/health.ts`, which
 * imports `queue/delayedOrphans.ts`, which needed the name back — a cycle whose
 * behaviour depends on which module the graph is entered at. Enter it at
 * `setup.js` and real ESM throws `Cannot access 'QUEUE_NAMESPACE' before
 * initialization`, while Vite's transform silently yields `undefined` and every
 * derived key becomes `groupmq:undefined:*`: a prefix nothing writes, read by a
 * probe that then reports an empty, healthy queue forever.
 *
 * A leaf module cannot be half-initialized, so the name is here and nowhere
 * else. Keep this file import-free.
 */

/** The name the MTA gives its GroupMQ queue. */
export const QUEUE_NAMESPACE = 'owlat-mta';

/**
 * The full Redis key prefix GroupMQ derives from that name — `Queue` prepends
 * `groupmq:` to the namespace it is configured with. Derived here, once, so the
 * handful of reads that must go to raw keys cannot drift from the queue they
 * claim to be describing.
 */
export const QUEUE_KEY_NAMESPACE = `groupmq:${QUEUE_NAMESPACE}`;
