#!/usr/bin/env bash
# Adds one paragraph to a release's notes, once. Used by the release builds
# to say when something in the release isn't signed (the Windows installer
# with no TOHYEE_RELEASE_SIGNING_KEY, the Android app with no release key).
# Two builds can edit the notes at the same time and one could overwrite the
# other's paragraph, so it reads the notes back and adds it again if needed.
#
#   TAG=v1.2.3 GH_REPO=owner/repo scripts/add-release-note.sh "Paragraph text"
#
# Needs gh with a token that can write releases.
set -euo pipefail

tag="${TAG:?Set TAG (v<version>)}"
note="${1:?Give the paragraph to add}"
notes_file="${RUNNER_TEMP:-/tmp}/release-notes-${RANDOM}.md"

for attempt in 1 2 3 4 5 6; do
  body="$(gh release view "$tag" --json body --jq .body)"
  if grep -qF -- "$note" <<<"$body"; then
    echo "The release notes for ${tag} say: ${note}"
    exit 0
  fi
  if [ "$attempt" -eq 6 ]; then break; fi
  printf '%s\n\n%s\n' "$body" "$note" > "$notes_file"
  gh release edit "$tag" --notes-file "$notes_file" > /dev/null
  rm -f "$notes_file"
  # Give another build's edit time to land, then read it back.
  sleep $((RANDOM % 6 + 3))
done
echo "::warning title=Release notes::Couldn't add this to the notes for ${tag}: ${note}"
