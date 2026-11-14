/**
 * The transactional sender form: an address built from a typed local part and
 * a chosen sending domain, a display name, and the verdict that says whether
 * it can be saved. The backend (`transactional/senderResolution.ts`
 * `requireVerifiedSender`) refuses the same cases; this mirrors it so the
 * operator learns why before saving, not from a refusal.
 *
 * Pure and framework-free: copy travels as message keys.
 */

import { isValidEmail } from '@owlat/shared';
import type { LocalizedText } from '~/utils/localizedText';

const K = 'shared.transactionalSender.verdict';

/** The Transactional page with its sender dialog open: where the sender is set. */
export const TRANSACTIONAL_SENDER_HREF = '/dashboard/send/transactional?sender=edit';

/** Longest display name the backend accepts. */
const MAX_NAME_LENGTH = 100;

export interface SendingDomainOption {
	domain: string;
	isVerified: boolean;
}

export interface SenderDraft {
	localPart: string;
	domain: string;
	name: string;
}

export interface SenderDraftVerdict {
	tone: 'neutral' | 'success' | 'warning';
	message: LocalizedText;
	/** Whether the draft may be saved. */
	canSave: boolean;
	/** True when the fix is on the Domains page, so the verdict links there. */
	showDomainsLink: boolean;
}

/** `noreply@mail.example.com` → `{ localPart: 'noreply', domain: 'mail.example.com' }`. */
export function splitSenderAddress(address: string | null | undefined): {
	localPart: string;
	domain: string;
} {
	const value = address?.trim() ?? '';
	const at = value.lastIndexOf('@');
	if (at === -1) return { localPart: value, domain: '' };
	return { localPart: value.slice(0, at), domain: value.slice(at + 1).toLowerCase() };
}

/** The address a draft spells, or `''` while either half is empty. */
export function senderDraftAddress(draft: SenderDraft): string {
	const localPart = draft.localPart.trim();
	const domain = draft.domain.trim().toLowerCase();
	return localPart && domain ? `${localPart}@${domain}` : '';
}

/**
 * Where the form starts. An existing sender is shown as it is. A new one
 * suggests the transactional subdomain, else the first verified domain, and
 * borrows the local part and name of the address it would replace, so the
 * common case is a single change of domain.
 */
export function initialSenderDraft(input: {
	current: { email: string; name: string | null } | null;
	suggestedDomain: string | null;
	domains: readonly SendingDomainOption[];
	fallback: { address: string; name: string } | null;
}): SenderDraft {
	if (input.current) {
		return { ...splitSenderAddress(input.current.email), name: input.current.name ?? '' };
	}
	const domain =
		input.suggestedDomain ?? input.domains.find((option) => option.isVerified)?.domain ?? '';
	return {
		localPart: splitSenderAddress(input.fallback?.address).localPart,
		domain,
		name: input.fallback?.name ?? '',
	};
}

export function senderDraftVerdict(
	draft: SenderDraft,
	domains: readonly SendingDomainOption[]
): SenderDraftVerdict {
	const blocked = (message: LocalizedText, showDomainsLink = false): SenderDraftVerdict => ({
		tone: 'warning',
		message,
		canSave: false,
		showDomainsLink,
	});
	if (domains.length === 0) return blocked(`${K}.noDomains`, true);
	if (!draft.localPart.trim() || !draft.domain.trim()) {
		return {
			tone: 'neutral',
			message: `${K}.enterAddress`,
			canSave: false,
			showDomainsLink: false,
		};
	}
	if (!isValidEmail(senderDraftAddress(draft))) return blocked(`${K}.invalidAddress`);
	const name = draft.name.trim();
	if (name.length > MAX_NAME_LENGTH || /[\r\n]/.test(name)) {
		return blocked({ key: `${K}.nameTooLong`, params: { max: MAX_NAME_LENGTH } });
	}
	const domain = draft.domain.trim().toLowerCase();
	const option = domains.find((candidate) => candidate.domain === domain);
	if (!option) return blocked({ key: `${K}.domainMissing`, params: { domain } }, true);
	if (!option.isVerified)
		return blocked({ key: `${K}.domainUnverified`, params: { domain } }, true);
	return {
		tone: 'success',
		message: { key: `${K}.domainVerified`, params: { domain } },
		canSave: true,
		showDomainsLink: false,
	};
}

/** Whether a draft would save something other than what is stored now. */
export function isSenderDraftChanged(
	draft: SenderDraft,
	current: { email: string; name: string | null } | null
): boolean {
	if (!current) return true;
	return (
		senderDraftAddress(draft) !== current.email.trim() ||
		draft.name.trim() !== (current.name ?? '').trim()
	);
}

/** How recipients see the sender: `Name <address>`, or the bare address. */
export function formatFromAddress(name: string, address: string): string {
	const trimmed = name.trim();
	return trimmed ? `${trimmed} <${address}>` : address;
}
