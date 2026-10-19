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
#   - one queued Send for the named contact on the sent campaign, imported as a
#     raw row (`convex import`, checked against FROM's schema): no route queues
#     a Send without also dispatching it. It carries no provider id and no
#     `firstAttemptAt`, so nothing settles it: the lost-send sweep leaves
#     never-attempted Sends alone, and the install has no MTA or provider.
#   - the campaign stats rollup, run once (see "Stats" below).
#
# The baseline, taken at FROM, is a set of documents keyed by id:
#   - the roots: the first sample contact by email, the sent sample campaign
#     and each of its Sends, the draft sample campaign, the queued Send;
#   - every document reachable from a root through id-valued fields within
#     DATA_HOPS hops, every captured document traversed alike (so a Send's
#     recipient is in it, and the draft's template and what that points at).
# After the update exactly those ids are loaded again and compared with their
# baseline document. A path ("draft/emailTemplateId") only labels a document in
# messages; a reference added later cannot move or hide one. Each document is
# reported under the invariant of the root it was first reached from:
#   contact | campaign | draft | queued-send
# Rules per document:
#   - it still exists;
#   - every field it had is still there, deep-equal (arrays compare whole);
#   - it gained no top-level soft-delete marker (`deletedAt`, `archivedAt`,
#     `isDeleted`, ...: an unset optional field is not stored, so tombstoning a
#     row only ADDS one);
#   - other added fields pass (a migration may add defaults), except on the
#     queued Send, which must be the identical document: an added
#     `firstAttemptAt` or provider id means something attempted it.
# A field a migration of TO rewrites on purpose goes in DATA_REWRITE_ALLOWLIST.
#   rows         no contacts/campaigns/emailSends/emailTemplates row went missing
#
# Stats: the sample loader writes the sent campaign's `stats*` counters inline,
# without the stat shards they are a cache of, and the backend's rollup cron
# (`campaigns/statShards.ts` rollupSentCampaignStats, every 2 minutes) resets
# them to the shard sums whenever it next runs. So the same rollup runs through
# the admin key right before each snapshot. It writes only when a counter
# differs from its shards, so both snapshots see the same normalised counters
# and the same `statsUpdatedAt`, and every counter is compared strictly.
#
# Rows are read with `convex run --inline-query` (a sandboxed read-only query).
# The two writes call FROM's and TO's functions by name (sample data, rollup),
# so renaming either breaks the next release's update flow until FROM has the
# new name too.
# ═══════════════════════════════════════════════════════════════════════════════

# The install's own Convex CLI: FROM's convex-deploy image before the update,
# TO's after it, both pointed at the install's backend with its admin key.
convex_cli() {
	docker compose --profile deploy run --rm -T convex-deploy "$@"
}

convex_query() {
	convex_cli convex run --inline-query "$1" </dev/null
}

# How far the baseline follows id-valued fields from a root.
DATA_HOPS=2

# Fields a migration shipped in TO rewrites on purpose, so their FROM value is
# not expected to survive. One object per field:
#   {"to": "<TO version>", "doc": "<document label>", "field": "<dotted path>",
#    "migration": "<migrations/NNNN_name.ts>"}
# The label is the one failures print (`contact`, `draft/emailTemplateId`, ...).
# An entry applies only to an update to its `to` version. v0.6.14 → v0.6.15
# needs none: no migration or schema change shipped in that range.
DATA_REWRITE_ALLOWLIST='[]'

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

# Helpers both snapshot queries start with. A Convex id names its table, so
# `db.get(id)` alone finds the row; a string that is not an id throws and loads
# nothing.
data_query_helpers() {
	cat <<'JS'
    const load = async (id) => {
      try {
        return await ctx.db.get(id);
      } catch {
        return null;
      }
    };
    const rowIds = async (table) =>
      (await ctx.db.query(table).collect()).map((row) => row._id).sort();
    const rows = async () => ({
      contacts: await rowIds('contacts'),
      campaigns: await rowIds('campaigns'),
      emailSends: await rowIds('emailSends'),
      emailTemplates: await rowIds('emailTemplates'),
    });
JS
}

# The baseline. $1 is the ids object `{contact, campaign, draft, queuedSend}`;
# Convex ids are lowercase alphanumerics, which is checked before they go into
# the source. Returns `{roles, sends, manifest, docs, rows}`: `docs` maps each
# captured id to its whole document, `manifest` maps it to
# `{invariant, label, strict}`.
#
# Breadth-first from all roots at once, so a document is captured exactly when
# it lies within DATA_HOPS of some root, whatever order references come in.
data_baseline_query() {
	local roles="$1"
	jq -e '[.contact, .campaign, .draft, .queuedSend] | all(type == "string" and test("^[a-z0-9]+$"))' \
		<<<"$roles" >/dev/null || return 1
	local compact
	compact="$(jq -c '{contact, campaign, draft, queuedSend}' <<<"$roles")"
	cat <<JS
export default query({
  handler: async (ctx) => {
    const roles = ${compact};
$(data_query_helpers)
    const refsOf = (value, path, out) => {
      if (typeof value === 'string' && /^[0-9a-z]{31,37}\$/.test(value)) out.push([path, value]);
      else if (Array.isArray(value)) value.forEach((item, i) => refsOf(item, path + '.' + i, out));
      else if (value !== null && typeof value === 'object')
        for (const [key, item] of Object.entries(value)) refsOf(item, path ? path + '.' + key : key, out);
      return out;
    };
    const sends = (await ctx.db.query('emailSends').collect())
      .filter((row) => row.campaignId === roles.campaign && row._id !== roles.queuedSend)
      .map((row) => row._id)
      .sort();
    const roots = [
      [roles.contact, 'contact', 'contact'],
      [roles.campaign, 'campaign', 'campaign'],
      ...sends.map((id) => [id, 'campaign', 'campaign/send:' + id]),
      [roles.draft, 'draft', 'draft'],
      [roles.queuedSend, 'queued-send', 'queued-send'],
    ];
    const manifest = {};
    const docs = {};
    let level = [];
    for (const [id, invariant, label] of roots) {
      if (id in manifest) continue;
      manifest[id] = { invariant, label, strict: id === roles.queuedSend };
      docs[id] = await load(id);
      level.push(id);
    }
    for (let hop = 1; hop <= ${DATA_HOPS}; hop++) {
      const next = [];
      for (const from of level) {
        if (docs[from] === null) continue;
        for (const [path, id] of refsOf(docs[from], '', [])) {
          if (id in manifest) continue;
          const doc = await load(id);
          if (doc === null) continue;
          manifest[id] = {
            invariant: manifest[from].invariant,
            label: manifest[from].label + '/' + path,
            strict: false,
          };
          docs[id] = doc;
          next.push(id);
        }
      }
      level = next;
    }
    return { roles, sends, manifest, docs, rows: await rows() };
  },
});
JS
}

# After the update: the baseline's ids ($1, a JSON array), loaded again.
# Returns `{docs, rows}`, a missing document as null.
data_reload_query() {
	local ids="$1"
	jq -e 'type == "array" and length > 0 and all(type == "string" and test("^[a-z0-9]+$"))' \
		<<<"$ids" >/dev/null || return 1
	cat <<JS
export default query({
  handler: async (ctx) => {
    const ids = $(jq -c . <<<"$ids");
$(data_query_helpers)
    const docs = {};
    for (const id of ids) docs[id] = await load(id);
    return { docs, rows: await rows() };
  },
});
JS
}

# What seeding must have produced before the update is worth running: every
# named row present and in the state its invariant describes. Prints one line
# per problem; silent and 0 when the baseline is usable.
data_snapshot_problems() {
	jq -r '
		.roles as $r | .docs as $d
		| def doc($id): if $id == null then null else $d[$id] end;
		(if doc($r.contact) == null then "the named contact is missing" else empty end),
		(doc($r.campaign) as $c
		 | if $c == null then "the sent campaign is missing"
		 elif $c.status != "sent" then "the sent campaign has status \($c.status)"
		 elif (.sends | length) == 0 then "the sent campaign has no sample Sends"
		 else empty end),
		(doc($r.draft) as $c
		 | if $c == null then "the draft campaign is missing"
		 elif $c.status != "draft" then "the draft campaign has status \($c.status)"
		 elif doc($c.emailTemplateId) == null then "the draft campaign has no template"
		 else empty end),
		(doc($r.queuedSend) as $s
		 | if $s == null then "the queued Send is missing"
		 elif $s.status != "queued" then "the queued Send has status \($s.status)"
		 elif $s.providerMessageId != null or $s.firstAttemptAt != null then "the queued Send was attempted"
		 elif $s.contactId != $r.contact or $s.campaignId != $r.campaign then "the queued Send does not reference the named contact and campaign"
		 else empty end)
	' "$1"
}

# Compares the reload taken after the update ($2) with the baseline taken at
# FROM ($1), for an update to version $3, by the rules in the header. Prints
# `ok|<invariant>` or `bad|<invariant>|<what changed>` per invariant, each
# change as `<label>:<field path> ...`, and returns 1 when any is bad.
data_compare_snapshots() {
	local result
	result="$(jq -r --slurpfile after "$2" --arg to "$3" --argjson allow "$DATA_REWRITE_ALLOWLIST" '
		def leaves($p):
			if type == "object" and length > 0 then (to_entries[] as $e | $e.value | leaves($p + [$e.key]))
			else [$p, .] end;
		def present($doc; $p):
			($doc | getpath($p[:-1])) as $parent | ($parent | type) == "object" and ($parent | has($p[-1]));
		def dotted: map(tostring) | join(".");
		def allowed($label; $field): $allow | any(.to == $to and .doc == $label and .field == $field);
		def problems($m; $before; $after):
			if $before == null then empty
			elif $after == null then "\($m.label) is gone (was \($before._id))"
			else
				($before | leaves([]) | . as [$p, $v] | ($p | dotted) as $field
				 | select(allowed($m.label; $field) | not)
				 | if present($after; $p) | not then "\($m.label):\($field) removed (was \($v | tojson))"
				   elif ($after | getpath($p)) != $v then "\($m.label):\($field) \($v | tojson) → \($after | getpath($p) | tojson)"
				   else empty end),
				(if $m.strict then
					$after | leaves([]) | . as [$p, $v] | ($p | dotted) as $field
					| select(present($before; $p) | not) | select(allowed($m.label; $field) | not)
					| "\($m.label):\($field) added \($v | tojson)"
				 else
					$after | keys[] | select(test("^((deleted|archived|erased|trashed)(At|By)|is(Deleted|Archived))$"))
					| select(. as $field | $before | has($field) | not)
					| "\($m.label):\(.) added \($after[.] | tojson) (soft-deleted)"
				 end)
			end;
		.manifest as $manifest | .docs as $before | $after[0].docs as $now
		| (["contact", "campaign", "draft", "queued-send"][] as $name
		   | [$manifest | to_entries[] | select(.value.invariant == $name)
		      | problems(.value; $before[.key]; $now[.key])] as $diff
		   | if ($diff | length) == 0 then "ok|\($name)" else "bad|\($name)|\($diff | join("; "))" end),
		  ([.rows | to_entries[] | .key as $table
		    | (.value - ($after[0].rows[$table] // [])) as $lost
		    | select($lost | length > 0) | "\($table): \($lost | join(", "))"] as $missing
		   | if ($missing | length) == 0 then "ok|rows" else "bad|rows|missing \($missing | join("; "))" end)
	' "$1")" || return 1
	printf '%s\n' "$result"
	! grep -q '^bad|' <<<"$result"
}

# The backend's own campaign stats rollup, the function its cron runs, once.
# $1 names the release for the failure message.
data_rollup_stats() {
	convex_cli convex run campaigns/statShards:rollupSentCampaignStats '{}' </dev/null >/dev/null ||
		fail "could not run the campaign stats rollup at $1"
}

# At FROM, once its functions are deployed: write the data, check it is what
# the invariants describe and keep the baseline in $1.
seed_convex_data() {
	local baseline="$1" summary roles send ids problems

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

	data_rollup_stats "$FROM"
	convex_query "$(data_baseline_query "$ids")" >"$baseline" || fail "could not snapshot the seeded rows"
	problems="$(data_snapshot_problems "$baseline")"
	[[ -z "$problems" ]] || fail "the seeded data is not what the invariants describe: $problems"
	pass "seeded: contact, sent campaign, draft campaign and a queued Send ($(jq '.docs | length' "$baseline") documents in the baseline; rows $(jq -c '.rows | map_values(length)' "$baseline"))"
}

# At TO, after the update: the baseline's documents again, compared with it.
verify_convex_data() {
	local baseline="$1" after="$1.after"
	data_rollup_stats "$TO"
	convex_query "$(data_reload_query "$(jq -c '.docs | keys' "$baseline")")" >"$after" ||
		fail "could not reload the seeded rows at $TO"
	local report status=0 verdict name detail
	report="$(data_compare_snapshots "$baseline" "$after" "$TO")" || status=1
	while IFS='|' read -r verdict name detail; do
		if [[ "$verdict" == ok ]]; then
			pass "$name survived the update"
		else
			printf '  \033[31m✗\033[0m %s: %s\n' "$name" "$detail"
		fi
	done <<<"$report"
	[[ $status -eq 0 ]] || fail "seeded Convex data did not survive the update to $TO"
}
