/**
 * THE SETUP WIZARD'S STEP RULES — pure, and deliberately a module of their own.
 *
 * Every rule a step gates on lives here: what makes an admin account usable,
 * what makes an email step complete, and WHICH of those rules a screen that
 * only changes the transport can meet. They are pure functions over the draft
 * types, so a step's gate is unit-testable without mounting Nuxt or a browser.
 *
 * Because they are pure — no component, no `useI18n` — every message they report
 * is a message KEY (the i18n registry convention); the screen that announces the
 * error resolves it with `t()`.
 *
 * Split out of `useSetupWizard` the same way `setupOutboundTls` was, and for the
 * same reason: that file holds the shared reactive state, the review summary and
 * the apply body, and the rules kept growing beside them until the pair sat over
 * the file-size ratchet. The draft TYPES stay with the state they describe and
 * are imported here as types only, so nothing about this split creates a cycle.
 */

import { meetsMinPasswordLength } from '@owlat/shared/passwordPolicy';
import { isOwnSendProviderKind } from '@owlat/shared/sendProviderCatalog';
import { validateMtaIdentityDraft } from '~/utils/setupMtaIdentity';
import {
	credentialFieldsFor,
	requiredCredentialError,
	type MissingCredentialMessage,
	type TransportCredentialValues,
} from './setupWizardCredentials';
import type { AdminDraft, EmailStepDraft } from './useSetupWizard';

// Mirrors the server's deliberately-lenient check in apply.post.ts so the client
// never blocks an address the backend would accept (or vice-versa). Named
// distinctly from the strict `@owlat/shared` `isValidEmail`.
const EMAIL_RE = /^.+@.+\..+$/;

export function isSetupEmailValid(value: string): boolean {
	return EMAIL_RE.test(value.trim());
}

export interface AdminErrors {
	email?: string;
	password?: string;
}

export function validateAdmin(admin: AdminDraft): AdminErrors {
	const errors: AdminErrors = {};
	if (!isSetupEmailValid(admin.email)) {
		errors.email = 'shared.setupWizardValidation.admin.emailInvalid';
	}
	if (!meetsMinPasswordLength(admin.password)) {
		// The rules are pure, so a message here is a KEY; the screen resolves it
		// with `{ min: MIN_PASSWORD_LENGTH }` from the same shared policy.
		errors.password = 'shared.setupWizardValidation.admin.passwordTooShort';
	}
	return errors;
}

export function adminIsValid(admin: AdminDraft): boolean {
	return Object.keys(validateAdmin(admin)).length === 0;
}

export interface EmailStepErrors {
	provider?: string;
	/**
	 * The selected kind's ONE credential error, as a sentence key plus the label
	 * key of the field it is about — the screen resolves both with
	 * `t(key, { field: t(field) })`. At most one, because the rules below stop at
	 * the first field that fails.
	 */
	credentials?: MissingCredentialMessage;
	mtaIdentity?: string;
	fromEmail?: string;
}

/**
 * THE SENTENCE A KIND'S INCOMPLETE CREDENTIALS READ AS — wording, keyed by kind,
 * and optional per kind.
 *
 * WHICH fields are required is never decided here: that is each descriptor's
 * `required` flag, read by `requiredCredentialError`. This table only keeps the
 * sentence each incumbent's form has always shown, because a credential SET
 * ("Region, access key ID, and secret access key are all required for SES") is
 * worded better than its first blank field. A kind with no row — every bundled
 * plugin transport, and the next core one until someone writes its sentence —
 * gets the generic "Enter {field}." naming that field, so a missing row is never
 * a form that refuses without saying why.
 */
const INCOMPLETE_CREDENTIALS_COPY: Readonly<Record<string, string>> = {
	ses: 'shared.setupWizardValidation.email.sesIncomplete',
	smtp: 'shared.setupWizardValidation.email.smtpIncomplete',
	resend: 'shared.setupWizardValidation.email.resendKeyRequired',
	mandrill: 'shared.setupWizardValidation.email.mandrillKeyRequired',
	emailit: 'shared.setupWizardValidation.email.emailitKeyRequired',
};

/** An endpoint port is optional (blank ⇒ the descriptor's default), but if given must be real. */
function isValidPort(port: string): boolean {
	const trimmed = port.trim();
	if (trimmed === '') return true;
	if (!/^\d+$/.test(trimmed)) return false;
	const n = Number.parseInt(trimmed, 10);
	return n >= 1 && n <= 65535;
}

/**
 * The selected kind's credential error, from its catalog descriptors: the first
 * required field left blank, then any endpoint whose port is not a port.
 */
function credentialRuleError(
	kind: string,
	values: TransportCredentialValues
): MissingCredentialMessage | undefined {
	const missing = requiredCredentialError(kind, values);
	if (missing !== undefined) {
		const sentence = Object.hasOwn(INCOMPLETE_CREDENTIALS_COPY, kind)
			? INCOMPLETE_CREDENTIALS_COPY[kind]
			: undefined;
		return sentence === undefined ? missing : { ...missing, key: sentence };
	}
	for (const field of credentialFieldsFor(kind)) {
		if (field.kind === 'host-port' && !isValidPort(values[field.portEnvVar] ?? '')) {
			return { key: 'shared.setupWizardValidation.email.smtpPortInvalid', field: field.label };
		}
	}
	return undefined;
}

export function validateEmailStep(draft: EmailStepDraft): EmailStepErrors {
	const errors: EmailStepErrors = {};

	if (draft.provider === 'none' && draft.requiresProvider) {
		errors.provider = 'shared.setupWizardValidation.email.providerRequired';
	}
	const credentialError = credentialRuleError(draft.provider, draft.credentials);
	if (credentialError !== undefined) errors.credentials = credentialError;
	// The sending IPs and the EHLO identity are the own arm's, asked through the
	// catalog's `tier: 'own'` declaration; they are also collected when the MTA
	// runs only as a receiving profile beside a relay.
	if (isOwnSendProviderKind(draft.provider) || draft.mtaProfileEnabled) {
		const identityError = validateMtaIdentityDraft(draft.mtaIdentity);
		if (identityError) errors.mtaIdentity = identityError;
	}
	// From-identity is optional, but if supplied it must be a real address.
	if (draft.fromEmail.trim() !== '' && !isSetupEmailValid(draft.fromEmail)) {
		errors.fromEmail = 'shared.setupWizardValidation.email.fromEmailInvalid';
	}

	return errors;
}

export function emailStepIsValid(draft: EmailStepDraft): boolean {
	return Object.keys(validateEmailStep(draft)).length === 0;
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
	credentials: true,
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
