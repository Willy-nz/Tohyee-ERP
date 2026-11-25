#!/usr/bin/env bash
# Makes a release GitHub's "latest" once every one of its files is there.
#
# release-on-version.yml creates each release with --latest=false, so
# /releases/latest (what every server's update check, the Windows updater,
# Docker's :latest and the website's Download use) keeps pointing at the
# previous release while the builds run. Each of the three build workflows
# runs this after attaching its files; whichever finishes last promotes the
# release. Running it again does no harm.
#
#   TAG=v1.2.3 GH_REPO=owner/repo scripts/promote-release.sh
#
# Needs gh (with a token that can write releases) and, to move the Docker
# :latest tags, docker logged in to ghcr.io (skipped with PROMOTE_DOCKER=no).
set -euo pipefail

tag="${TAG:?Set TAG (v<version>)}"
version="${tag#v}"
image="${TOHYEE_IMAGE:-ghcr.io/willy-nz/tohyee}"
postbox="${TOHYEE_POSTBOX_IMAGE:-ghcr.io/willy-nz/tohyee-postbox}"

if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "${tag} isn't v<x.y.z>."
  exit 1
fi

have="$(gh release view "$tag" --json assets --jq '.assets[].name')"
for file in "TohyeeSetup-${version}.exe" "TohyeeSetup-${version}.exe.sha256" \
  "tohyee-v${version}-linux-x64.tar.gz" "tohyee-v${version}-linux-x64.tar.gz.sha256" \
  "tohyee-v${version}-windows-docker.zip" "tohyee-v${version}-windows-docker.zip.sha256"; do
  if ! grep -qxF "$file" <<<"$have"; then
    echo "Not the latest release yet: waiting for ${file}."
    exit 0
  fi
done
if ! grep -qE "^Tohyee-${version//./\\.}(-test)?\.apk$" <<<"$have"; then
  echo "Not the latest release yet: waiting for the Android APK."
  exit 0
fi

# Never make an older release the latest (a build of an old tag run again, say).
current="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
if [ -n "$current" ] && [ "$current" != "$tag" ]; then
  newest="$(printf '%s\n%s\n' "${current#v}" "$version" | sort -V | tail -n 1)"
  if [ "$newest" != "$version" ]; then
    echo "${current} is newer than ${tag}, so ${tag} isn't made the latest."
    exit 0
  fi
fi

if [ "${PROMOTE_DOCKER:-yes}" != "no" ]; then
  # The images for this version were pushed before the server bundle was attached.
  docker buildx imagetools create -t "${image}:latest" "${image}:${version}"
  docker buildx imagetools create -t "${postbox}:latest" "${postbox}:${version}"
fi
gh release edit "$tag" --latest
echo "${tag} is now the latest release."
