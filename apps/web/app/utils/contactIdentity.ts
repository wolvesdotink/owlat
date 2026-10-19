/**
 * What a Contact goes by in the contacts list: its primary identity, for the
 * row's visible label and every name that row announces (open link, select
 * checkbox).
 *
 * `contacts.email` is optional (a Contact can arrive by phone, SMS, WhatsApp
 * or a generic channel with no email signal), so the label falls back from the
 * email to the full name, then to a localized "Unnamed contact". It never
 * fabricates an email and is never empty. The list query returns no other
 * identifier, so a phone or handle can only join this order once the list
 * projects one (a deferred backend extension).
 */

/** The identity fields the contacts list query already returns. */
export interface ContactIdentityFields {
	email?: string | null;
	firstName?: string | null;
	lastName?: string | null;
}

/** Whether the contact has a usable email, i.e. its email is the primary identity. */
export function contactHasEmail(contact: ContactIdentityFields): boolean {
	return Boolean(contact.email?.trim());
}

/** First and last name joined by a space; '' when the contact has neither. */
function contactFullName(contact: ContactIdentityFields): string {
	return [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean).join(' ');
}

/** Email, else full name, else the localized unnamed-contact label. */
export function contactPrimaryIdentity(
	contact: ContactIdentityFields,
	t: (key: string) => string
): string {
	return (
		contact.email?.trim() ||
		contactFullName(contact) ||
		t('dashboard.audience.contacts.index.unnamedContact')
	);
}
