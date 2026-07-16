/**
 * Argument builders for the external-mailbox connect form.
 *
 * The same form serves three backend calls — `connect` (personal),
 * `connectShared` (a team inbox), and `updateCredentials` — which all take the
 * identical credential shape. Keeping the trim/normalize logic here (pure, no
 * Convex, no component) lets it be unit-tested without mounting the form, and
 * guarantees the personal and shared paths never drift on how the address,
 * username default, or member roster are prepared.
 */

/** The mutable form state the connect form binds its inputs to. */
export interface MailboxConnectFormState {
	emailAddress: string;
	imapHost: string;
	imapPort: number;
	isImapSecure: boolean;
	smtpHost: string;
	smtpPort: number;
	isSmtpSecure: boolean;
	username: string;
	password: string;
}

/**
 * The credential args every connect/update backend call accepts. Structurally
 * identical to the form state (the form binds exactly the fields the backend
 * takes) — kept as a named alias so call sites read intent ("credential args"
 * vs "form state") without maintaining two interfaces that could drift.
 */
export type MailboxCredentialArgs = MailboxConnectFormState;

/** The extra fields `connectShared` layers on for a team inbox. */
export interface SharedInboxFields {
	displayName?: string;
	memberUserIds: string[];
}

/**
 * Normalize the raw form state into the credential args. Trims the text fields,
 * coerces the port strings to numbers, and defaults the login username to the
 * email address when the user left it blank (most providers share one login).
 */
export function buildCredentialArgs(form: MailboxConnectFormState): MailboxCredentialArgs {
	const email = form.emailAddress.trim();
	return {
		emailAddress: email,
		imapHost: form.imapHost.trim(),
		imapPort: Number(form.imapPort),
		isImapSecure: form.isImapSecure,
		smtpHost: form.smtpHost.trim(),
		smtpPort: Number(form.smtpPort),
		isSmtpSecure: form.isSmtpSecure,
		username: (form.username || email).trim(),
		password: form.password,
	};
}

/**
 * Credential args plus the shared-inbox fields for `connectShared`. Blanks the
 * display name back to `undefined` (so the backend falls back to the address)
 * and dedupes the selected member ids — the same defensive shape the backend
 * `_connectSharedInternal` applies, kept in step so the UI never sends a roster
 * with duplicates.
 */
export function buildSharedConnectArgs(
	form: MailboxConnectFormState,
	shared: SharedInboxFields
): MailboxCredentialArgs & SharedInboxFields {
	return {
		...buildCredentialArgs(form),
		displayName: shared.displayName?.trim() || undefined,
		memberUserIds: [...new Set(shared.memberUserIds)],
	};
}
