#!/bin/sh
# Command of the convex-deploy image (docker/convex-deploy.Dockerfile): deploy
# the functions this image carries, then record their release on the
# deployment.
#
# Convex functions read OWLAT_VERSION from the deployment's own environment
# (checkForUpdates, the desktop update feed, the GitHub user agent), not from
# the compose `.env`. Setup writes it once; every later deploy (the in-app
# updater, `owlat upgrade`, the manual path) runs this command and nothing
# else, so the version is set here, from the version baked into the image.
#
# The version is set only after `convex deploy` succeeded, so a failed deploy
# never claims the new release. A failure to set it does not fail the deploy:
# the functions are already live, and failing here would make the updater
# abort a rollout whose backend half already went through. Re-running this
# container sets it again.

convex deploy --url "$CONVEX_SELF_HOSTED_URL" --admin-key "$CONVEX_SELF_HOSTED_ADMIN_KEY" || exit $?

if [ -z "${OWLAT_VERSION:-}" ]; then
	echo "warning: this image carries no OWLAT_VERSION; the deployment's OWLAT_VERSION was left unchanged" >&2
	exit 0
fi

# `convex env set` reads CONVEX_SELF_HOSTED_URL/_ADMIN_KEY from the
# environment; it has no --url/--admin-key flags. With the value given as an
# argument it never reads stdin.
if convex env set -- OWLAT_VERSION "$OWLAT_VERSION" </dev/null; then
	echo "OWLAT_VERSION set to $OWLAT_VERSION on the deployment"
else
	echo "warning: the functions deployed, but setting OWLAT_VERSION=$OWLAT_VERSION on the deployment failed; the backend keeps reporting its previous version until this runs again: docker compose --profile deploy run --rm convex-deploy" >&2
fi
exit 0
