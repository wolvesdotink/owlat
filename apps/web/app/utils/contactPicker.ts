import type { Id } from '@owlat/api/dataModel';

/**
 * Minimal shape returned by `contacts.contacts.list` that a contact picker needs
 * to display and select a contact. Mirrors the candidate row used by the
 * relationships picker (`useContactRelationships`).
 */
export interface PickerContact {
	_id: Id<'contacts'>;
	email?: string;
	firstName?: string;
	lastName?: string;
}

/**
 * Human label for a contact row: full name when present, otherwise the email,
 * otherwise the id (a contact with neither a name nor an email is unusual but
 * the schema allows an absent email).
 * Shared by every contact picker so the displayed label is consistent.
 */
export function contactPickerLabel(contact: PickerContact): string {
	const name = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
	return name || contact.email || contact._id;
}

/**
 * Append a contact to the selection, de-duplicating by id. Returns a new array
 * (never mutates the input) so callers can assign it back to a ref cleanly.
 */
export function addPickedContact(
	selected: PickerContact[],
	contact: PickerContact,
): PickerContact[] {
	if (selected.some((c) => c._id === contact._id)) return selected;
	return [...selected, contact];
}

/**
 * Remove a contact from the selection by id. Returns a new array.
 */
export function removePickedContact(
	selected: PickerContact[],
	contactId: Id<'contacts'>,
): PickerContact[] {
	return selected.filter((c) => c._id !== contactId);
}

/**
 * Candidate rows that aren't already selected — what the search dropdown offers.
 */
export function unselectedCandidates(
	candidates: PickerContact[],
	selected: PickerContact[],
): PickerContact[] {
	const taken = new Set(selected.map((c) => c._id));
	return candidates.filter((c) => !taken.has(c._id));
}
