/**
 * The updater's request bodies, checked before a handler reads a field. Each
 * parser answers the checked value, or `null` for a body that is not one; the
 * handlers read bodies through `readJsonBody` (http.ts), which turns `null`
 * into a 400 before any rollout, Docker or disk work starts.
 *
 * Plain parsers rather than schema validators: this sidecar bundles its whole
 * dependency graph into one file and has no other use for a schema runtime.
 */

/** A JSON object, as opposed to an array, `null` or a scalar. */
export function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export interface UpdateBody {
	/** Absent, `null` or empty: the update keeps the compose file on disk. */
	composeTemplate?: string;
	/** Checked by the handler, which drops one that is not an attempt id. */
	attempt?: unknown;
}

export function readUpdateBody(value: unknown): UpdateBody | null {
	const body = asRecord(value);
	if (!body) return null;
	const { composeTemplate, attempt } = body;
	if (composeTemplate === undefined || composeTemplate === null) return { attempt };
	if (typeof composeTemplate !== 'string') return null;
	return { composeTemplate, attempt };
}

export interface ConfigureIpBody {
	ip: string;
	action: 'add' | 'remove';
}

export function readConfigureIpBody(value: unknown): ConfigureIpBody | null {
	const body = asRecord(value);
	if (!body) return null;
	const { ip, action } = body;
	if (typeof ip !== 'string' || !ip || (action !== 'add' && action !== 'remove')) return null;
	return { ip, action };
}
