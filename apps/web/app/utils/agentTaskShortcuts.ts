/**
 * Single-key shortcut vocabulary shared by every agent task card (Reply Queue
 * clarification cards, draft-on-arrival review slots, Review Queue cards):
 *
 *   1–9    → pick the matching option chip
 *   Enter  → submit / primary action
 *   s      → skip (non-destructive "I'll deal with this later")
 *   e      → edit the draft (where a draft exists)
 *   Escape → exit the card (drop focus back to the list)
 *
 * Pure key→action resolution so the mapping is unit-testable without mounting
 * a Convex-backed surface. Modifier chords (Cmd/Ctrl/Alt) and keystrokes inside
 * an editable target are filtered by the CALLER (the card's keydown handler or
 * the listbox composable) — this module only maps plain keys.
 */

export type AgentTaskShortcut =
	| { type: 'chip'; index: number }
	| { type: 'submit' }
	| { type: 'skip' }
	| { type: 'edit' }
	| { type: 'exit' };

export function resolveAgentTaskShortcut(key: string): AgentTaskShortcut | null {
	if (/^[1-9]$/.test(key)) return { type: 'chip', index: Number(key) - 1 };
	switch (key) {
		case 'Enter':
			return { type: 'submit' };
		case 's':
			return { type: 'skip' };
		case 'e':
			return { type: 'edit' };
		case 'Escape':
			return { type: 'exit' };
		default:
			return null;
	}
}
