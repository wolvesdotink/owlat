import { useOrganization } from '~/composables/useOrganization';
import { colleagueLine } from '~/utils/companies';

/**
 * The "Taylor is also in touch with Northwind." line of a company, naming the
 * colleagues the server reports (`colleagueUserIds`) from the workspace roster.
 * Null when no colleague is in touch. `short` gives "Taylor also in touch", for
 * a summary that names the company already.
 */
export function useCompanyColleagues() {
	const { t } = useI18n();
	const { members, fetchMembers } = useOrganization();
	onMounted(() => {
		void fetchMembers();
	});

	const nameById = computed(() => {
		const map = new Map<string, string>();
		for (const member of members.value) {
			const name = member.user.name?.trim() || member.user.email;
			if (name) map.set(member.userId, name);
		}
		return map;
	});

	function lineFor(
		company: { name: string; colleagueUserIds: readonly string[] },
		opts: { short?: boolean } = {}
	): string | null {
		const names: string[] = [];
		let unnamed = 0;
		for (const id of company.colleagueUserIds) {
			const name = nameById.value.get(id);
			if (name) names.push(name);
			else unnamed += 1;
		}
		const message = colleagueLine(names, unnamed, company.name, opts);
		if (!message) return null;
		return message.plural === undefined
			? t(message.key, message.params)
			: t(message.key, message.params, message.plural);
	}

	return { lineFor };
}
