#!/bin/sh
# Pin the Dockerfile's base image to the current digest of its tag.
#   scripts/pin-base-image.sh [tag]     (default: the tag already in the Dockerfile)
# Needs Docker with buildx and network access to the registry. Review the
# diff before committing: the digest decides what every build starts from.
set -eu
cd "$(dirname "$0")/.."
current=$(sed -n 's/^ARG NODE_IMAGE=\([^@]*\)@.*/\1/p' Dockerfile)
tag="${1:-$current}"
[ -n "$tag" ] || { echo "No ARG NODE_IMAGE=<tag>@sha256:<digest> line in Dockerfile" >&2; exit 1; }
digest=$(docker buildx imagetools inspect "$tag" | awk '/^Digest:/ {print $2; exit}')
case "$digest" in
  sha256:????????????????????????????????????????????????????????????????) ;;
  *) echo "Could not resolve a digest for $tag (got '$digest')" >&2; exit 1 ;;
esac
sed -i.bak "s|^ARG NODE_IMAGE=.*|ARG NODE_IMAGE=$tag@$digest|" Dockerfile && rm -f Dockerfile.bak
echo "Pinned $tag@$digest"
