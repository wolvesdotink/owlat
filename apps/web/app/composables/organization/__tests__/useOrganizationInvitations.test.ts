/**
 * The invitation writes: a cancelled invite also drops what was reserved for
 * the invitee (the pending mailbox, and the team-inbox grants keyed by their
 * email, which would otherwise materialize on a later join), and a resend
 * inside the cooldown never reaches BetterAuth.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { getFunctionName } from 'convex/server';

const { inviteMember, cancelInvitation } = vi.hoisted(() => ({
	inviteMember: vi.fn(),
	cancelInvitation: vi.fn(),
}));
vi.mock('~/lib/auth-client', () => ({ inviteMember, cancelInvitation }));

import { useOrganizationInvitations } from '../useOrganizationInvitations';

const runs = new Map<string, ReturnType<typeof vi.fn>>();
const run = (name: string) => runs.get(name)!;
const fetchMembers = vi.fn(async () => {});

beforeEach(() => {
	runs.clear();
	fetchMembers.mockClear();
	inviteMember.mockReset();
	cancelInvitation.mockReset();
	vi.stubGlobal('useBackendOperation', (fn: unknown) => {
		const name = getFunctionName(fn as never);
		const spy = vi.fn(async () => ({ ok: true, result: null }));
		runs.set(name, spy);
		return { run: spy };
	});
});

function invitations() {
	return useOrganizationInvitations({
		t: (key) => key,
		organizationId: ref<string | null>('org-1'),
		fetchMembers,
	});
}

describe('useOrganizationInvitations', () => {
	it('cancels an invite with its reserved mailbox and inbox grants, then reloads', async () => {
		cancelInvitation.mockResolvedValue({ data: { id: 'inv-1' }, error: null });
		const { cancelInvite } = invitations();

		await cancelInvite('inv-1', 'new@owlat.example');

		expect(cancelInvitation).toHaveBeenCalledWith({ invitationId: 'inv-1' });
		expect(run('mail/pendingMailbox:cancelForInvitation')).toHaveBeenCalledWith({
			invitationId: 'inv-1',
		});
		expect(run('mail/pendingInboxMembership:cancelInboxMembershipsForEmail')).toHaveBeenCalledWith({
			inviteeEmail: 'new@owlat.example',
		});
		expect(fetchMembers).toHaveBeenCalledWith({ force: true });
	});

	it('reserves the invitee mailbox with the invite, as BetterAuth calls an editor a member', async () => {
		inviteMember.mockResolvedValue({ data: { id: 'inv-2' }, error: null });
		const { invite } = invitations();

		const result = await invite('new@owlat.example', 'editor', {
			localpart: 'new',
			domain: 'owlat.example',
		});

		expect(result).toEqual({ invitationId: 'inv-2' });
		expect(inviteMember).toHaveBeenCalledWith({
			organizationId: 'org-1',
			email: 'new@owlat.example',
			role: 'member',
		});
		expect(run('mail/pendingMailbox:setForInvitation')).toHaveBeenCalledWith({
			invitationId: 'inv-2',
			inviteeEmail: 'new@owlat.example',
			localpart: 'new',
			domain: 'owlat.example',
			displayName: undefined,
		});
	});

	it('does not resend inside the cooldown', async () => {
		const { resendInvite } = invitations();
		run('auth/invitationResend:throttleResend').mockResolvedValue({ ok: false });

		const sent = await resendInvite({ id: 'inv-3', email: 'new@owlat.example', role: 'admin' });

		expect(sent).toBe(false);
		expect(inviteMember).not.toHaveBeenCalled();
	});
});
