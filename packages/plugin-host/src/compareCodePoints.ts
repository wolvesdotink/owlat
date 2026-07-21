/** Deterministic ordering independent of process locale. */
export function compareCodePoints(left: string, right: string): number {
	if (left === right) return 0;
	return left < right ? -1 : 1;
}
