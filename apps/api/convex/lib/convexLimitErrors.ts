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

/**
 * Whether a failure is Convex refusing a value against a validator or the
 * schema. The platform raises these as plain errors with no code, so this reads
 * the wording; like the limit check above, it is the one place that does.
 */
export function isConvexValidationError(message: string): boolean {
	return /does not match the schema|validator|ValidationError/i.test(message);
}

/**
 * Whether a failure is the paginator refusing a cursor it did not issue for
 * the query. The deployed backend says "Failed to parse cursor" for one that
 * does not decode and names a cursor from another query `InvalidCursor` (the
 * text Convex's own `usePaginatedQuery` matches on); the test backend decodes
 * a cursor with `JSON.parse` and passes on its message.
 */
export function isInvalidCursorError(message: string): boolean {
	return /Failed to parse cursor|InvalidCursor|is not valid JSON/.test(message);
}
