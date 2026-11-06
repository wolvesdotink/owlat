/**
 * Argument helpers both halves of the tool catalog share (`mcp/protocol.ts`
 * for the reads, `mcp/writeTools.ts` for the writes). Pure.
 */

export const mailboxIdProperty = {
	type: 'string',
	description: 'A mailbox id from list_mailboxes.',
};

export function optionalString(
	args: Record<string, unknown>,
	key: string
): { ok: true; value?: string } | { ok: false } {
	const value = args[key];
	if (value === undefined || value === null) return { ok: true };
	if (typeof value !== 'string' || value.length === 0) return { ok: false };
	return { ok: true, value };
}

/** A required id argument. */
export function requiredId(args: Record<string, unknown>, key: string): string | null {
	const value = optionalString(args, key);
	return value.ok && value.value !== undefined ? value.value : null;
}
