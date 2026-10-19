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
# FROM. Each covers whole stored documents, not chosen fields:
#   contact      the first sample contact by email
#   campaign     the sent sample campaign and each of its Sends
#   draft        the draft sample campaign
#   queued-send  the imported Send
# plus every document one of those names by id, and every document that one
# names (the draft's template and what the template points at). A document
# survives when every field it had at FROM is still there, deep-equal, and it
# did not gain a soft-delete marker (`deletedAt`, `archivedAt`, `isDeleted`, ...;
# an unset optional field is not stored, so tombstoning a row only ADDS one).
# Other new fields pass: a migration may add defaults. A field a migration of
# TO rewrites on purpose goes in DATA_REWRITE_ALLOWLIST, naming the migration;
# a field the backend recomputes on a timer goes in DATA_DERIVED_FIELDS, naming
# the writer.
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

# Fields a migration shipped in TO rewrites on purpose, so their FROM value is
# not expected to survive. One object per field:
#   {"to": "<TO version>", "doc": "<snapshot key>", "field": "<dotted path>",
#    "migration": "<migrations/NNNN_name.ts>"}
# An entry applies only to an update to its `to` version. v0.6.14 → v0.6.15
# needs none: no migration or schema change shipped in that range.
DATA_REWRITE_ALLOWLIST='[]'

# Fields the running backend recomputes itself, in FROM and in TO alike, on a
# timer that can fire on either side of the update, so their FROM value says
# nothing about survival. One object per field:
#   {"doc": "<snapshot key>", "field": "<dotted path>", "writer": "<where>"}
# Today that is the sent campaign's stats cache: `campaigns/statShards.ts`
# rollupSentCampaignStats sums the stat shards into it every 2 minutes for
# campaigns sent in the last 14 days, and stamps statsUpdatedAt. The sample
# loader writes those numbers inline without shards, so the first rollup resets
# them to the shard sums. The Sends they summarise are checked under `campaign`.
# The field list is CAMPAIGN_SHARDED_STAT_FIELDS (convex/lib/validators/
# campaigns.ts), which a test keeps in step.
DATA_DERIVED_FIELDS="$(printf '%s\n' statsUpdatedAt statsSent statsFailed statsDelivered statsOpened \
	statsAutomatedOpened statsClicked statsAutomatedClicked statsBounced statsHardBounced statsSoftBounced \
	statsSendTimeOptimizedDelivered statsSendTimeOptimizedOpened statsSendTimeOptimizedClicked \
	statsSendTimeHoldoutDelivered statsSendTimeHoldoutOpened statsSendTimeHoldoutClicked |
	jq -Rnc '[inputs | {doc: "campaign", field: ., writer: "campaigns/statShards.ts rollupSentCampaignStats, every 2 minutes"}]')"

# The snapshot both sides of the update are compared on. $1 is the ids object
# `{contact, campaign, draft, queuedSend}`; Convex ids are lowercase
# alphanumerics, which is checked before they go into the source.
#
# `docs` maps a key to a whole stored document: the invariant's name for the
# named row, `campaign/send:<id>` for each of the sent campaign's Sends, and
# `<key>/<field path>` for a document reached through an id-shaped field (two
# hops from a named row, each document listed once). Ids are recognised by
# shape and confirmed by loading them; a string that is not an id loads nothing.
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
    const load = async (id) => {
      try {
        return await ctx.db.get(id);
      } catch {
        return null;
      }
    };
    const refsOf = (value, path, out) => {
      if (typeof value === 'string' && /^[0-9a-z]{31,37}\$/.test(value)) out.push([path, value]);
      else if (Array.isArray(value)) value.forEach((item, i) => refsOf(item, path + '.' + i, out));
      else if (value !== null && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) refsOf(item, path ? path + '.' + key : key, out);
      return out;
    };
    const docs = {};
    const seen = new Set([ids.contact, ids.campaign, ids.draft, ids.queuedSend]);
    const add = async (key, doc, hops) => {
      docs[key] = doc;
      if (doc === null || hops === 0) return;
      for (const [path, id] of refsOf(doc, '', [])) {
        if (seen.has(id)) continue;
        seen.add(id);
        const target = await load(id);
        if (target !== null) await add(key + '/' + path, target, hops - 1);
      }
    };
    const sends = await ctx.db.query('emailSends').collect();
    const campaignSends = sends.filter(
      (row) => row.campaignId === ids.campaign && row._id !== ids.queuedSend
    );
    for (const row of campaignSends) seen.add(row._id);
    await add('contact', await load(ids.contact), 2);
    await add('campaign', await load(ids.campaign), 2);
    for (const row of campaignSends) await add('campaign/send:' + row._id, row, 0);
    await add('draft', await load(ids.draft), 2);
    await add('queued-send', await load(ids.queuedSend), 2);
    const rowIds = async (table) =>
      (await ctx.db.query(table).collect()).map((row) => row._id).sort();
    return {
      docs,
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
		.docs as $d
		| (if $d.contact == null then "the named contact is missing" else empty end),
		(if $d.campaign == null then "the sent campaign is missing"
		 elif $d.campaign.status != "sent" then "the sent campaign has status \($d.campaign.status)"
		 elif ($d | keys | any(startswith("campaign/send:")) | not) then "the sent campaign has no sample Sends"
		 else empty end),
		(if $d.draft == null then "the draft campaign is missing"
		 elif $d.draft.status != "draft" then "the draft campaign has status \($d.draft.status)"
		 elif $d["draft/emailTemplateId"] == null then "the draft campaign has no template"
		 else empty end),
		(($d["queued-send"]) as $s
		 | if $s == null then "the queued Send is missing"
		 elif $s.status != "queued" then "the queued Send has status \($s.status)"
		 elif $s.providerMessageId != null or $s.firstAttemptAt != null then "the queued Send was attempted"
		 elif $s.contactId != $d.contact._id or $s.campaignId != $d.campaign._id then "the queued Send does not reference the named contact and campaign"
		 else empty end)
	' "$1"
}

# Compares the snapshot taken after the update ($2) with the one taken at FROM
# ($1), for an update to version $3. Every document of an invariant must still
# exist, still hold every field it had, deep-equal (arrays compare whole), and
# not have gained a top-level soft-delete marker. Fields in
# DATA_REWRITE_ALLOWLIST (for $3) and DATA_DERIVED_FIELDS are not compared.
# Prints `ok|<invariant>` or `bad|<invariant>|<what changed>` per invariant and
# returns 1 when any is bad.
data_compare_snapshots() {
	local result
	result="$(jq -r --slurpfile after "$2" --arg to "$3" --argjson allow "$DATA_REWRITE_ALLOWLIST" \
		--argjson derived "$DATA_DERIVED_FIELDS" '
		def leaves($p):
			if type == "object" and length > 0 then (to_entries[] as $e | $e.value | leaves($p + [$e.key]))
			else [$p, .] end;
		def present($doc; $p):
			($doc | getpath($p[:-1])) as $parent | ($parent | type) == "object" and ($parent | has($p[-1]));
		def dotted: map(tostring) | join(".");
		def allowed($key; $field):
			($allow | any(.to == $to and .doc == $key and .field == $field))
			or ($derived | any(.doc == $key and .field == $field));
		def problems($key; $before; $after):
			if $before == null then empty
			elif $after == null then "\($key) is gone (was \($before._id))"
			else $before | leaves([]) | . as [$p, $v] | ($p | dotted) as $field
			| select(allowed($key; $field) | not)
			| if present($after; $p) | not then "\($key):\($field) removed (was \($v | tojson))"
			  elif ($after | getpath($p)) != $v then "\($key):\($field) \($v | tojson) → \($after | getpath($p) | tojson)"
			  else empty end
			end,
			if $before == null or $after == null then empty
			else $after | keys[] | select(test("^((deleted|archived|erased|trashed)(At|By)|is(Deleted|Archived))$"))
			| select(. as $field | $before | has($field) | not)
			| "\($key):\(.) added \($after[.] | tojson) (soft-deleted)"
			end;
		.docs as $before | $after[0].docs as $now
		| (["contact", "campaign", "draft", "queued-send"][] as $name
		   | [$before | keys[] | select(. == $name or startswith($name + "/")) as $key
		      | problems($key; $before[$key]; $now[$key])] as $diff
		   | if ($diff | length) == 0 then "ok|\($name)" else "bad|\($name)|\($diff | join("; "))" end),
		  ([.rows | to_entries[] | .key as $table
		    | (.value - ($after[0].rows[$table] // [])) as $lost
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
	pass "seeded: contact, sent campaign, draft campaign and a queued Send ($(jq '.docs | length' "$snapshot") documents snapshotted; rows $(jq -c '.rows | map_values(length)' "$snapshot"))"
}

# At TO, after the update: the same snapshot, compared with FROM's.
verify_convex_data() {
	local before="$1" after="$1.after" ids
	ids="$(cat "$before.ids")"
	convex_query "$(data_snapshot_query "$ids")" >"$after" || fail "could not snapshot the seeded rows at $TO"
	local report status=0
	report="$(data_compare_snapshots "$before" "$after" "$TO")" || status=1
	while IFS='|' read -r verdict name detail; do
		if [[ "$verdict" == ok ]]; then
			pass "$name survived the update"
		else
			printf '  \033[31m✗\033[0m %s: %s\n' "$name" "$detail"
		fi
	done <<<"$report"
	[[ $status -eq 0 ]] || fail "seeded Convex data did not survive the update to $TO"
}
