/**
 * Shipped values of the auto-send trust controls on AI replies, used where the
 * agent config leaves a field unset and as the target of each control's Reset.
 * The working-hours window mirrors the fallback the server's gate applies to an
 * unset field (`convex/lib/workingHours.ts`); item coverage is unenforced until
 * an owner turns it on.
 */
export const WORKING_HOURS_DEFAULTS = {
	enabled: false,
	/** Minutes from local midnight: 09:00. */
	start: 9 * 60,
	/** Minutes from local midnight: 17:00. */
	end: 17 * 60,
	/** Monday to Friday (0 = Sunday). */
	days: [1, 2, 3, 4, 5] as readonly number[],
} as const;

export const ITEM_COVERAGE_ENFORCED_DEFAULT = false;
