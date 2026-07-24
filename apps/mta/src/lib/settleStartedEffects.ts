/** Wait for every started effect, then surface failures in input order. */
export async function settleStartedEffects(
	effects: ReadonlyArray<Promise<unknown>>
): Promise<void> {
	const results = await Promise.allSettled(effects);
	const firstFailure = results.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected'
	);
	if (firstFailure) throw firstFailure.reason;
}
