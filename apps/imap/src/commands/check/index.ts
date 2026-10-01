import type { ImapCommandModule } from '../types.js';
import { reportNews } from '../noop/index.js';

/**
 * CHECK — RFC 3501 sync barrier. We have no in-memory state to flush;
 * Convex mutations are durable on return. Like NOOP, it announces other
 * sessions' changes to the selected folder before its OK.
 */
export const checkModule: ImapCommandModule<void> = {
	verbs: ['CHECK'],
	parseArgs: () => ({ ok: true, args: undefined }),
	start: reportNews,
};
