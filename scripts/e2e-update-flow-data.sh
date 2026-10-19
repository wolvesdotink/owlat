# shellcheck shell=bash
# ═══════════════════════════════════════════════════════════════════════════════
# e2e-update-flow-data.sh — Convex data that has to survive an update.
#
# Sourced by e2e-update-flow.sh, which runs from the install directory and
# defines log/pass/fail. The schema guard (convex/__tests__/schemaCompat) proves
# the previous release's table shapes still validate; this proves rows a real
# previous release wrote are still there, unchanged, after the in-app update
# deployed the next release's functions over them.
#
# Seeding, at FROM:
#   - FROM's sample data, so FROM's own loaders write the contacts, the sent
#     campaign with its Sends and the draft campaign. They run inert: the
#     automation is paused, the webhook disabled. It is the mutation behind
#     `POST /sample-data/install`, run with the admin key: the route itself needs
#     the auth secrets setup writes, which this bare install does not have.
#     FROM's function is called by name, so renaming it breaks the next
#     release's update flow until FROM has the new name too.
#   - one queued Send for the named contact on the sent campaign, imported as a
#     raw row (`convex import`, checked against FROM's schema): no route queues
#     a Send without also dispatching it. It carries no provider id and no
#     `firstAttemptAt`, so nothing settles it: the lost-send sweep leaves
#     never-attempted Sends alone, and the install has no MTA or provider.
#
# The named invariants, checked after the update against the snapshot taken at
# FROM (same row ids, same fields):
#   contact      the first sample contact by email
#   campaign     the sent sample campaign, and how many Sends it has
#   draft        the draft sample campaign, and that its template still exists
#   queued-send  the imported Send: still queued, never attempted
#   rows         no contacts/campaigns/emailSends/emailTemplates row went missing
#
# Rows are read with `convex run --inline-query` (a sandboxed read-only query),
# so the check does not depend on either release's function names.
# ═══════════════════════════════════════════════════════════════════════════════

# The install's own Convex CLI: FROM's convex-deploy image before the update,
# TO's after it, both pointed at the install's backend with its admin key.
convex_cli() {
	docker compose --profile deploy run --rm -T convex-deploy "$@"
}

convex_query() {
	convex_cli convex run --inline-query "$1" </dev/null
}

# Ids of the rows the invariants are about. `queuedSends` lists every queued
# Send; seeding expects none before the import and exactly one after it.
data_roles_query() {
	cat <<'JS'
export default query({
  handler: async (ctx) => {
    const sample = async (table) =>
      (await ctx.db.query(table).collect()).filter((row) => row.seedTag === 'demo');
    const by = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);
    const contact = (await sample('contacts')).sort(by('email'))[0] ?? null;
    const campaigns = (await sample('campaigns')).sort(by('name'));
    const campaign = campaigns.find((row) => row.status === 'sent') ?? null;
    const draft = campaigns.find((row) => row.status === 'draft') ?? null;
    const queued = (await ctx.db.query('emailSends').collect()).filter(
      (row) => row.status === 'queued'
    );
    return {
      contact: contact && { id: contact._id, email: contact.email },
      campaign: campaign && campaign._id,
      draft: draft && draft._id,
      queuedSends: queued.map((row) => row._id),
    };
  },
});
JS
}

# The snapshot both sides of the update are compared on. $1 is the ids object
# `{contact, campaign, draft, queuedSend}`; Convex ids are lowercase
# alphanumerics, which is checked before they go into the source.
data_snapshot_query() {
	local ids="$1"
	jq -e '[.contact, .campaign, .draft, .queuedSend] | all(type == "string" and test("^[a-z0-9]+$"))' \
		<<<"$ids" >/dev/null || return 1
	local compact
	compact="$(jq -c '{contact, campaign, draft, queuedSend}' <<<"$ids")"
	cat <<JS
export default query({
  handler: async (ctx) => {
    const ids = ${compact};
    const pick = (doc, keys) =>
      doc === null ? null : Object.fromEntries(keys.map((key) => [key, doc[key] ?? null]));
    const rowIds = async (table) =>
      (await ctx.db.query(table).collect()).map((row) => row._id).sort();
    const sends = await ctx.db.query('emailSends').collect();
    const contact = await ctx.db.get(ids.contact);
    const campaign = await ctx.db.get(ids.campaign);
    const draft = await ctx.db.get(ids.draft);
    const queuedSend = await ctx.db.get(ids.queuedSend);
    const draftTemplate =
      draft && draft.emailTemplateId ? await ctx.db.get(draft.emailTemplateId) : null;
    return {
      contact: pick(contact, ['_id', '_creationTime', 'email', 'firstName', 'lastName']),
      campaign: campaign && {
        ...pick(campaign, [
          '_id', '_creationTime', 'name', 'status', 'subject', 'emailTemplateId', 'sentAt', 'statsSent',
        ]),
        sends: sends.filter((row) => row.campaignId === ids.campaign).length,
      },
      draft: draft && {
        ...pick(draft, ['_id', '_creationTime', 'name', 'status', 'subject', 'emailTemplateId']),
        templateExists: draftTemplate !== null,
      },
      queuedSend: pick(queuedSend, [
        '_id', '_creationTime', 'status', 'campaignId', 'contactId', 'contactEmail', 'queuedAt',
        'providerMessageId', 'firstAttemptAt',
      ]),
      rows: {
        contacts: await rowIds('contacts'),
        campaigns: await rowIds('campaigns'),
        emailSends: sends.map((row) => row._id).sort(),
        emailTemplates: await rowIds('emailTemplates'),
      },
    };
  },
});
JS
}

# What seeding must have produced before the update is worth running: every
# named row present and in the state its invariant describes. Prints one line
# per problem; silent and 0 when the snapshot is usable.
data_snapshot_problems() {
	jq -r '
		(if .contact == null then "the named contact is missing" else empty end),
		(if .campaign == null then "the sent campaign is missing"
		 elif .campaign.status != "sent" then "the sent campaign has status \(.campaign.status)"
		 elif .campaign.sends < 2 then "the sent campaign has \(.campaign.sends) Sends, expected its sample Sends plus the queued one"
		 else empty end),
		(if .draft == null then "the draft campaign is missing"
		 elif .draft.status != "draft" then "the draft campaign has status \(.draft.status)"
		 elif .draft.templateExists != true then "the draft campaign has no template"
		 else empty end),
		(if .queuedSend == null then "the queued Send is missing"
		 elif .queuedSend.status != "queued" then "the queued Send has status \(.queuedSend.status)"
		 elif .queuedSend.providerMessageId != null or .queuedSend.firstAttemptAt != null then "the queued Send was attempted"
		 elif .queuedSend.contactId != .contact._id or .queuedSend.campaignId != .campaign._id then "the queued Send does not reference the named contact and campaign"
		 else empty end)
	' "$1"
}

# Compares the snapshot taken after the update ($2) with the one taken at FROM
# ($1). Prints `ok|<invariant>` or `bad|<invariant>|<what changed>` per named
# invariant and returns 1 when any is bad.
data_compare_snapshots() {
	local result
	result="$(jq -r --slurpfile after "$2" '
		. as $before | $after[0] as $after
		| def changed($role):
			[($before[$role] // {}) | keys_unsorted[] as $key
			 | select($before[$role][$key] != ($after[$role] // {})[$key])
			 | "\($key): \($before[$role][$key] | tojson) → \(($after[$role] // {})[$key] | tojson)"];
		def check($name; $role):
			if $after[$role] == null then "bad|\($name)|row \($before[$role]._id) is gone"
			else changed($role) as $diff
			| if ($diff | length) == 0 then "ok|\($name)" else "bad|\($name)|\($diff | join("; "))" end
			end;
		check("contact"; "contact"),
		check("campaign"; "campaign"),
		check("draft"; "draft"),
		check("queued-send"; "queuedSend"),
		([$before.rows | to_entries[] | .key as $table
		  | (.value - ($after.rows[$table] // [])) as $lost
		  | select($lost | length > 0) | "\($table): \($lost | join(", "))"] as $missing
		 | if ($missing | length) == 0 then "ok|rows" else "bad|rows|missing \($missing | join("; "))" end)
	' "$1")" || return 1
	printf '%s\n' "$result"
	! grep -q '^bad|' <<<"$result"
}

# At FROM, once its functions are deployed: write the data, check it is what
# the invariants describe and keep the snapshot in $1.
seed_convex_data() {
	local snapshot="$1" summary roles send ids problems

	# Idempotent, so retried: right after a deploy the backend's own cron
	# catch-up can briefly exceed its write limit.
	local attempt
	for attempt in 1 2 3 4 5; do
		summary="$(convex_cli convex run sampleData/index:install '{}' </dev/null)" && break
		[[ $attempt -lt 5 ]] || fail "could not install $FROM's sample data"
		sleep 10
	done
	pass "$FROM installed its sample data: $(jq -c '.inserted' <<<"$summary")"

	roles="$(convex_query "$(data_roles_query)")" || fail "could not read the sample rows"
	jq -e '.contact != null and .campaign != null and .draft != null and .queuedSends == []' \
		<<<"$roles" >/dev/null || fail "the sample data lacks a named row, or already has a queued Send: $roles"

	send="$(jq -c --argjson now "$(($(date +%s) * 1000))" \
		'{campaignId: .campaign, contactId: .contact.id, contactEmail: .contact.email, status: "queued", queuedAt: $now}' \
		<<<"$roles")"
	convex_cli sh -c 'cat >/tmp/queued-send.jsonl && convex import --table emailSends --append -y /tmp/queued-send.jsonl </dev/null' \
		<<<"$send" >/dev/null || fail "could not import the queued Send"

	roles="$(convex_query "$(data_roles_query)")" || fail "could not read the sample rows"
	jq -e '.queuedSends | length == 1' <<<"$roles" >/dev/null ||
		fail "expected exactly one queued Send after the import: $roles"
	ids="$(jq -c '{contact: .contact.id, campaign, draft, queuedSend: .queuedSends[0]}' <<<"$roles")"

	convex_query "$(data_snapshot_query "$ids")" >"$snapshot" || fail "could not snapshot the seeded rows"
	problems="$(data_snapshot_problems "$snapshot")"
	[[ -z "$problems" ]] || fail "the seeded data is not what the invariants describe: $problems"
	printf '%s\n' "$ids" >"$snapshot.ids"
	pass "seeded: contact, sent campaign, draft campaign and a queued Send ($(jq -c '.rows | map_values(length)' "$snapshot") rows)"
}

# At TO, after the update: the same snapshot, compared with FROM's.
verify_convex_data() {
	local before="$1" after="$1.after" ids line
	ids="$(cat "$before.ids")"
	convex_query "$(data_snapshot_query "$ids")" >"$after" || fail "could not snapshot the seeded rows at $TO"
	local report status=0
	report="$(data_compare_snapshots "$before" "$after")" || status=1
	while IFS='|' read -r verdict name detail; do
		if [[ "$verdict" == ok ]]; then
			pass "$name survived the update"
		else
			printf '  \033[31m✗\033[0m %s: %s\n' "$name" "$detail"
		fi
	done <<<"$report"
	[[ $status -eq 0 ]] || fail "seeded Convex data did not survive the update to $TO"
}
