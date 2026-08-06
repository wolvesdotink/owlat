/**
 * THE SETUP WIZARD'S STEP RULES — pure, and deliberately a module of their own.
 *
 * Every rule a step gates on lives here: what makes an admin account usable,
 * what makes an email step complete, and WHICH of those rules a screen that
 * only changes the transport can meet. They are pure functions over the draft
 * types, so a step's gate is unit-testable without mounting Nuxt or a browser.
 *
 * Split out of `useSetupWizard` the same way `setupOutboundTls` was, and for the
 * same reason: that file holds the shared reactive state, the review summary and
 * the apply body, and the rules kept growing beside them until the pair sat over
 * the file-size ratchet. The draft TYPES stay with the state they describe and
 * are imported here as types only, so nothing about this split creates a cycle.
 */

import { validateMtaIdentityDraft } from '~/utils/setupMtaIdentity';
import type { AdminDraft, EmailStepDraft } from './useSetupWizard';

// Mirrors the server's deliberately-lenient check in apply.post.ts so the client
// never blocks an address the backend would accept (or vice-versa). Named
// distinctly from the strict `@owlat/shared` `isValidEmail` (also auto-imported)
// to avoid a Nuxt auto-import collision.
const EMAIL_RE = /^.+@.+\..+$/;

export function isSetupEmailValid(value: string): boolean {
	return EMAIL_RE.test(value.trim());
}

export const MIN_PASSWORD_LENGTH = 12;

export interface AdminErrors {
	email?: string;
	password?: string;
}

export function validateAdmin(admin: AdminDraft): AdminErrors {
	const errors: AdminErrors = {};
	if (!isSetupEmailValid(admin.email)) {
		errors.email = 'Enter a valid email address.';
	}
	if (admin.password.length < MIN_PASSWORD_LENGTH) {
		errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
	}
	return errors;
}

export function adminIsValid(admin: AdminDraft): boolean {
	return Object.keys(validateAdmin(admin)).length === 0;
}

export interface EmailStepErrors {
	provider?: string;
	resendKey?: string;
	mandrillKey?: string;
	ses?: string;
	smtp?: string;
	mtaIdentity?: string;
	fromEmail?: string;
}

/** A relay port is optional (defaults to 587), but if given must be a real port. */
function isValidSmtpPort(port: string): boolean {
	const trimmed = port.trim();
	if (trimmed === '') return true;
	if (!/^\d+$/.test(trimmed)) return false;
	const n = Number.parseInt(trimmed, 10);
	return n >= 1 && n <= 65535;
}

export function validateEmailStep(draft: EmailStepDraft): EmailStepErrors {
	const errors: EmailStepErrors = {};

	if (draft.provider === 'none' && draft.requiresProvider) {
		errors.provider =
			'A delivery provider is required because campaigns, transactional, or automations are enabled. Pick your own MTA, Amazon SES, or an SMTP relay — or disable bulk sending.';
	}
	if (draft.provider === 'resend' && draft.resendKey.trim() === '') {
		errors.resendKey = 'Enter your Resend API key.';
	}
	if (draft.provider === 'mandrill' && draft.mandrillKey.trim() === '') {
		errors.mandrillKey = 'Enter your Mailchimp Transactional (Mandrill) API key.';
	}
	if (draft.provider === 'ses') {
		const { region, accessKeyId, secretAccessKey } = draft.ses;
		if (!region.trim() || !accessKeyId.trim() || !secretAccessKey.trim()) {
			errors.ses = 'Region, access key ID, and secret access key are all required for SES.';
		}
	}
	if (draft.provider === 'smtp') {
		const { host, port, username, password } = draft.smtp;
		if (!host.trim() || !username.trim() || !password.trim()) {
			errors.smtp = 'Server host, username, and password are all required for an SMTP relay.';
		} else if (!isValidSmtpPort(port)) {
			errors.smtp = 'Port must be a whole number between 1 and 65535 (leave blank for 587).';
		}
	}
	if (draft.provider === 'mta' || draft.mtaProfileEnabled) {
		const identityError = validateMtaIdentityDraft(draft.mtaIdentity);
		if (identityError) errors.mtaIdentity = identityError;
	}
	// From-identity is optional, but if supplied it must be a real address.
	if (draft.fromEmail.trim() !== '' && !isSetupEmailValid(draft.fromEmail)) {
		errors.fromEmail = 'Enter a valid From address, or leave it blank.';
	}

	return errors;
}

export function emailStepIsValid(draft: EmailStepDraft): boolean {
	return Object.keys(validateEmailStep(draft)).length === 0;
}

/**
 * WHICH ERRORS ARE ABOUT THE CREDENTIALS — the one question both credential
 * surfaces ask, answered here rather than twice in their templates.
 *
 * `satisfies Record<keyof EmailStepErrors, boolean>` for the same reason
 * {@link TRANSPORT_EDITOR_OWNED_ERRORS} does it: the NEXT credential key this
 * step gains has to be classified here or the build fails. The alternative —
 * the `errors.resendKey ?? errors.mandrillKey ?? …` chain both components used
 * to spell out — was per-vendor knowledge in a `.vue` file (the seams plan's
 * D5), in TWO copies, and silently non-exhaustive: a new key rendered nowhere
 * while Apply refused, which is a button that does nothing with no sentence
 * saying why.
 *
 * ORDER IS THE DECLARATION ORDER of `EmailStepErrors`, and it does not matter:
 * `validateEmailStep` reports at most ONE credential error, because each rule is
 * gated on the selected provider.
 */
const CREDENTIAL_ERRORS = {
	resendKey: true,
	mandrillKey: true,
	ses: true,
	smtp: true,
	// Not credentials: which transport to use, the wizard's own MTA identity
	// step, and the optional From address.
	provider: false,
	mtaIdentity: false,
	fromEmail: false,
} as const satisfies Record<keyof EmailStepErrors, boolean>;

/**
 * The ONE credential error the selected kind can raise, whichever field set it
 * belongs to — or `undefined` when the credentials are fine.
 *
 * Lives beside the rules that PRODUCE those keys so the two cannot be edited a
 * package apart from each other; the descriptor renderer then decides where the
 * message is announced, which is a question about the FORM, not about a vendor.
 */
export function credentialErrorFor(errors: EmailStepErrors): string | undefined {
	for (const key of Object.keys(CREDENTIAL_ERRORS) as (keyof EmailStepErrors)[]) {
		if (CREDENTIAL_ERRORS[key] && errors[key] !== undefined) return errors[key];
	}
	return undefined;
}

/**
 * WHICH OF THE EMAIL STEP'S RULES A TRANSPORT-ONLY SCREEN CAN MEET.
 *
 * The in-app transport editor swaps the transport on a RUNNING instance. It
 * renders the provider picker, the credential fields and the From identity —
 * and nothing else — so it can clear those errors and no others.
 * `mtaIdentity` is the setup wizard's: the sending IPs and the EHLO hostname
 * behind their PTR records are collected on that same step, are not in
 * `PROVIDER_ENV_KEYS`, and the apply endpoint rejects any key that is not. An
 * editor gated on that field is a screen where "Run your own MTA" does nothing
 * at all, with no sentence to say why.
 *
 * `satisfies Record<keyof EmailStepErrors, boolean>` is the point of the table:
 * the NEXT field the wizard adds to that step has to be classified here or the
 * build fails — which is the opposite of the previous shape, an inverted
 * allowlist that would have silently killed Apply on the new field instead.
 */
const TRANSPORT_EDITOR_OWNED_ERRORS = {
	provider: true,
	resendKey: true,
	mandrillKey: true,
	ses: true,
	smtp: true,
	fromEmail: true,
	mtaIdentity: false,
} as const satisfies Record<keyof EmailStepErrors, boolean>;

/**
 * Validity for a surface that changes the TRANSPORT ONLY: every rule the screen
 * can actually satisfy is satisfied. Lives here, beside {@link validateEmailStep}
 * itself, so the rules and the subset that applies to a given screen cannot be
 * edited a package apart from each other.
 */
export function transportStepIsValid(draft: EmailStepDraft): boolean {
	const errors = validateEmailStep(draft);
	return (Object.keys(errors) as (keyof EmailStepErrors)[]).every(
		(key) => !TRANSPORT_EDITOR_OWNED_ERRORS[key]
	);
}
