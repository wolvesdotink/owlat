/**
 * Whether a failed transaction ran into a per-transaction platform limit (data
 * or documents read or written, index ranges, functions scheduled or their
 * argument bytes). Convex reports those as plain errors worded "... in a single
 * function execution (limit: ...)", followed by a link to its limits page, so
 * this reads the message. The shorter phrases cover a backend that drops the
 * "single function execution" suffix.
 *
 * Timeouts and other errors are left out: a retry at the same size may clear
 * them. So is "Only a single paginated query ...", which links the pagination
 * docs instead: that is a code bug, and shrinking a page cannot fix it.
 *
 * Contact erasure and the workspace deletion's scheduler scan both shrink their
 * next batch on a limit error, so they share this one reading of the wording.
 */
export function isTransactionLimitError(message: string): boolean {
	return /in a single function execution|docs\.convex\.dev\/production\/state\/limits|too much data|too many (?:documents|index ranges|functions)/i.test(
		message
	);
}
