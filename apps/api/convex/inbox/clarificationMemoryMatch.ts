/**
 * Pure matching helpers for clarification answer-memory (see
 * `inbox/clarificationMemory.ts` for the Convex persistence surface).
 *
 * The clarification loop asks the owner a focused question when a good reply is
 * missing a fact only they can supply. WITHOUT MEMORY that becomes a per-email
 * tax: the same question ("what's the standard dock?") is asked forever. This
 * module turns an ANSWERED question into a durable, contact-scoped standing
 * answer and, before asking again, decides whether a stored answer already
 * resolves the slot — so Owlat never asks twice.
 *
 * Pure (no 'use node', no Convex ctx) so both surfaces — the inbound agent
 * `clarify` step and the personal-mail Reply Queue refinement — and the unit
 * tests import it without a live model or database.
 *
 * CONTACT-SCOPE ISOLATION (lib/contactScope.ts) is enforced here too, as
 * defence-in-depth on top of the scoped index read: an answer captured for
 * contact A must never fill a slot for contact B unless it was explicitly
 * promoted to an org-general fact (`contactId` undefined = fills for anyone).
 */

/** The minimal shape of a stored standing answer the matcher reasons over. */
export interface StandingAnswerRow {
	/** Contact the answer is scoped to; undefined = org-general (promoted). */
	contactId?: string | undefined;
	slotType: string;
	/** Deterministic match key — {@link normalizeQuestionKey}. */
	questionKey: string;
	answerValue: string;
	/** Freshness tie-breaker when several rows match one question. */
	updatedAt: number;
}

/** A question the pipeline is about to ask (before the memory check). */
export interface PendingQuestion {
	id: string;
	slotType: string;
	text: string;
}

/** A silent fill: the stored answer that resolves a pending question. */
export interface StandingFill {
	questionId: string;
	slotType: string;
	value: string;
}

/**
 * Deterministic match key for a clarification question. Two questions collide
 * only when they are the SAME slot kind AND normalize to the same text, so a
 * stored "what's the standard dock?" answer never silently fills an unrelated
 * `factual_lookup` question. Normalization lower-cases, strips punctuation, and
 * collapses whitespace so trivial phrasing/casing differences still match.
 */
export function normalizeQuestionKey(slotType: string, question: string): string {
	const normalized = question
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	return `${slotType}::${normalized}`;
}

/**
 * Is a stored answer visible to a slot being asked for `scopeContactId`?
 * Org-general answers (undefined `contactId`) fill for anyone; a contact-scoped
 * answer fills ONLY its own contact. Mirrors `lib/contactScope.ts`
 * `isContactScopeVisible` for the single-owner standing-answer shape.
 */
export function isStandingAnswerVisible(
	rowContactId: string | undefined,
	scopeContactId: string | undefined
): boolean {
	if (rowContactId === undefined) return true;
	return rowContactId === scopeContactId;
}

/** A question matched to the stored row that resolves it. Generic over the row
 * so a Convex caller keeps the full document (to bump usage) while a pure test
 * uses the minimal shape. */
export interface MatchedStandingAnswer<T extends StandingAnswerRow> {
	questionId: string;
	slotType: string;
	row: T;
}

/**
 * Given the stored rows the caller fetched for a scope and the questions about
 * to be asked, match each question to the visible stored answer that resolves
 * it. When several rows match one question the freshest (largest `updatedAt`)
 * wins. Questions with no match are omitted (they are still asked). Never
 * matches across contact scope. Generic so a Convex caller can bump usage on
 * the returned row.
 */
export function matchStandingAnswers<T extends StandingAnswerRow>(
	rows: readonly T[],
	questions: readonly PendingQuestion[],
	scopeContactId: string | undefined
): MatchedStandingAnswer<T>[] {
	const matches: MatchedStandingAnswer<T>[] = [];
	for (const question of questions) {
		const key = normalizeQuestionKey(question.slotType, question.text);
		let best: T | undefined;
		for (const row of rows) {
			if (row.questionKey !== key) continue;
			if (!isStandingAnswerVisible(row.contactId, scopeContactId)) continue;
			if (row.answerValue.trim().length === 0) continue;
			if (!best || row.updatedAt > best.updatedAt) best = row;
		}
		if (best) matches.push({ questionId: question.id, slotType: question.slotType, row: best });
	}
	return matches;
}

/**
 * The silent fills — one `{questionId, slotType, value}` per question a visible
 * stored answer resolves. Thin value-only projection of
 * {@link matchStandingAnswers}. Never fills across contact scope.
 */
export function selectFills(
	rows: readonly StandingAnswerRow[],
	questions: readonly PendingQuestion[],
	scopeContactId: string | undefined
): StandingFill[] {
	return matchStandingAnswers(rows, questions, scopeContactId).map((m) => ({
		questionId: m.questionId,
		slotType: m.slotType,
		value: m.row.answerValue,
	}));
}
