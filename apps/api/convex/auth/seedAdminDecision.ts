/**
 * The decisions of `POST /seed/admin` (`seedAdminHttp.ts`): whether a body can
 * seed at all, the organization it names, and what the route answers for each
 * outcome of the commit (`auth/seedAdminCommit.ts`). Pure: the route reads the
 * body and the one-shot probes, the commit writes.
 */

/** The request body as the route's validator admits it. */
export interface AdminSeedBody {
	email?: string;
	name?: string;
	passwordHash?: string;
	flags?: Record<string, boolean>;
	isMigrationMode?: boolean;
}

/** Everything the commit writes, decided before it runs. */
export interface AdminSeed {
	email: string;
	name: string;
	passwordHash: string;
	orgName: string;
	orgSlug: string;
	isMigrationMode: boolean;
	/** The wizard's flag map; absent when the body carries none, so the compiled-in defaults stay. */
	flags?: Record<string, boolean>;
}

export type AdminSeedOutcome =
	| { outcome: 'seeded'; userId: string }
	| { outcome: 'users_exist' }
	| { outcome: 'already_seeded' };

/** What the route answers. */
export type AdminSeedAnswer =
	| { kind: 'created'; userId: string }
	| { kind: 'refused'; category: 'invalid_input' | 'already_exists'; message: string };

export const USERS_EXIST: AdminSeedAnswer = {
	kind: 'refused',
	category: 'already_exists',
	message: 'Users already exist. Seed endpoint is one-shot only.',
};

export const ALREADY_SEEDED: AdminSeedAnswer = {
	kind: 'refused',
	category: 'already_exists',
	message: 'Admin seed has already completed on this instance.',
};

/**
 * The organization slug for the admin's email: its local part, lowercased,
 * with every run of other characters collapsed to one `-` and none at either
 * end, so a local part like `+++` does not yield the all-dashes slug `---`.
 */
export function organizationSlug(email: string): string {
	const slugBase = email
		.split('@')[0]
		?.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
	return slugBase && slugBase.length > 0 ? slugBase : 'org';
}

/**
 * The seed a body asks for, or the refusal for a body missing one of the three
 * strings. The refusal keeps the message the setup CLI and the web wizard show.
 */
export function planAdminSeed(
	body: AdminSeedBody
): { ok: true; seed: AdminSeed } | { ok: false; answer: AdminSeedAnswer } {
	if (!body.email || !body.name || !body.passwordHash) {
		return {
			ok: false,
			answer: {
				kind: 'refused',
				category: 'invalid_input',
				message: 'Missing required fields: email, name, passwordHash',
			},
		};
	}
	const hasFlags = body.flags !== undefined && Object.keys(body.flags).length > 0;
	return {
		ok: true,
		seed: {
			email: body.email,
			name: body.name,
			passwordHash: body.passwordHash,
			// Names the organization and seeds `instanceSettings.defaultFromName`.
			orgName: `${body.name}'s Team`,
			orgSlug: organizationSlug(body.email),
			isMigrationMode: body.isMigrationMode ?? false,
			...(hasFlags ? { flags: body.flags } : {}),
		},
	};
}

/** The answer for what the commit did. */
export function adminSeedAnswer(result: AdminSeedOutcome): AdminSeedAnswer {
	switch (result.outcome) {
		case 'seeded':
			return { kind: 'created', userId: result.userId };
		case 'users_exist':
			return USERS_EXIST;
		case 'already_seeded':
			return ALREADY_SEEDED;
	}
}
