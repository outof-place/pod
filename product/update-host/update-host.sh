# Where Pod's updates live (RELEASE-RUNBOOK.md), sourced by the release scripts.
# Every Pod since rc5 reads POD_UPDATE_FEED: a name we own, so it never changes whatever serves it.
POD_UPDATE_HOST=https://updates.pod.codes
POD_UPDATE_FEED=$POD_UPDATE_HOST/appcast.xml
# Every appcast names its DMG on our own name, POD_DOWNLOAD/<tag>/<DMG>, which the host answers with
# a 302 to the asset of release <tag> in POD_RELEASES_REPO (vercel.json): the signed feed names our
# URL, so the DMGs can move with a deploy and no appcast is signed again. The repo is public and holds
# nothing but signed DMGs, so downloads stay public once outof-place/pod is private.
POD_DOWNLOAD=$POD_UPDATE_HOST/download
POD_RELEASES_REPO=outof-place/pod-releases
POD_RELEASES_DOWNLOAD=https://github.com/$POD_RELEASES_REPO/releases/download
# Pods up to rc4 read GitHub's feed. It was last written for POD_BRIDGE_VERSION, the first release
# that reads POD_UPDATE_FEED, which moves them over.
POD_GITHUB_FEED=https://github.com/outof-place/pod/releases/download/appcast/appcast.xml
POD_BRIDGE_VERSION=1.0.0-rc5
# The host is the Vercel project pod-updates (team outofplace, no Git connection; the files are
# product/update-host). It serves the appcast and redirects: download/ to the releases repo, and
# rehearsal feeds to the public Blob store pod-updates, which the CLI reaches over OIDC through the
# project's development environment. No DMG lives on the host or in the store.
POD_UPDATE_SCOPE=outofplace
POD_UPDATE_ORG_ID=team_45cQ8U5xftW1IIc1RMgl1Jwz
POD_UPDATE_PROJECT_ID=prj_XExDFZ4AxGIEaMdRasENKtc8ByrN
POD_UPDATE_BLOB_STORE=store_6oaqIaz38g6zR40k
POD_UPDATE_BLOB_URL=https://6oaqiaz38g6zr40k.public.blob.vercel-storage.com
