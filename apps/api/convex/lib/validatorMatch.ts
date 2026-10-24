/**
 * The validator matcher lives with the worker wire contract, whose consumers
 * check Convex answers with it; the delivery path's workpool callback uses the
 * same one rather than a copy.
 */
export { matchesValidator } from '@owlat/worker-protocol/validatorMatch';
