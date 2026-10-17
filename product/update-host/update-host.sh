# Where Pod's updates live (RELEASE-RUNBOOK.md), sourced by the release scripts.
# Every Pod since rc5 reads POD_UPDATE_FEED: a name we own, so it never changes whatever serves it.
POD_UPDATE_HOST=https://updates.pod.codes
POD_UPDATE_FEED=$POD_UPDATE_HOST/appcast.xml
# Pods up to rc4 read GitHub's feed. It was last written for POD_BRIDGE_VERSION, the first release
# that reads POD_UPDATE_FEED, which moves them over.
POD_GITHUB_FEED=https://github.com/outof-place/pod/releases/download/appcast/appcast.xml
POD_BRIDGE_VERSION=1.0.0-rc5
# The host is the Vercel project pod-updates (team outofplace, no Git connection; the files are
# product/update-host). Its vercel.json redirects each archive to the public Blob store pod-updates,
# which the CLI reaches over OIDC through the project's development environment.
POD_UPDATE_SCOPE=outofplace
POD_UPDATE_ORG_ID=team_45cQ8U5xftW1IIc1RMgl1Jwz
POD_UPDATE_PROJECT_ID=prj_XExDFZ4AxGIEaMdRasENKtc8ByrN
POD_UPDATE_BLOB_STORE=store_6oaqIaz38g6zR40k
POD_UPDATE_BLOB_URL=https://6oaqiaz38g6zr40k.public.blob.vercel-storage.com
