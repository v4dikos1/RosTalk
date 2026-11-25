#!/bin/sh
# Publish dist/release-<version> as a GitHub release (P13, ADR 0026).
#
#   make publish-release VERSION=0.2.0 [RELEASE_REPO=owner/name] [DRY_RUN=1]
#
# The owner runs this with their own `gh auth login`; the script never asks
# for, reads or stores a token. DRY_RUN=1 checks the directory and prints the
# gh commands without sending anything (gh need not be logged in).
#
# Preconditions (checked): the release directory from `make release`, its
# SHA256SUMS matches the files and carries a valid Ed25519 signature, the tag
# v<version> exists locally and points at HEAD. The tag must be pushed before
# a real run (`git push origin v<version>`); gh refuses an unknown tag
# because of --verify-tag.

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=${RELEASE_VERSION:-${VERSION:-}}
REPO=${ROSTALK_RELEASE_REPO:-v4dikos1/RosTalk}
DRY_RUN=${DRY_RUN:-0}
GH=${GH:-gh}
GO=${GO:-go}

die() {
	echo "publish-release.sh: $*" >&2
	exit 1
}

[ -n "$VERSION" ] || die "VERSION is required: make publish-release VERSION=x.y.z"
case "$REPO" in
*[!A-Za-z0-9._/-]* | */*/* | /* | */ | *..*) die "RELEASE_REPO must be owner/name, got $REPO" ;;
?*/?*) ;;
*) die "RELEASE_REPO must be owner/name, got $REPO" ;;
esac

DIR=${OUT:-"$ROOT/dist/release-$VERSION"}
NOTES="$DIR.notes.md"
TAG="v$VERSION"

[ -d "$DIR" ] || die "$DIR does not exist; run make release VERSION=$VERSION first"
[ -f "$NOTES" ] || die "$NOTES is missing; it is written by make release"

FILES="RosTalk-Setup-$VERSION.exe RosTalk-$VERSION-portable.zip RosTalk-Server-Setup-$VERSION.zip
rostalk-server_${VERSION}_linux_amd64 rostalk-server_${VERSION}_linux_arm64 install.sh latest.json
SHA256SUMS SHA256SUMS.sig"
for name in $FILES; do
	[ -f "$DIR/$name" ] || die "$DIR/$name is missing"
done
extra=$(cd "$DIR" && ls -1 | grep -v -x -F -e "$(printf '%s\n' $FILES)" || true)
[ -z "$extra" ] || die "unexpected files in $DIR: $extra"

(cd "$DIR" && sha256sum -c --quiet SHA256SUMS) || die "SHA256SUMS does not match the files"
(
	cd "$ROOT/server"
	"$GO" run ./cmd/rostalk-sign verify --pubkey "$ROOT/deploy/release.pub" "$DIR/SHA256SUMS.sig" "$DIR/SHA256SUMS" >/dev/null
) || die "SHA256SUMS.sig is not a valid signature of the release key"
grep -q "\"version\": \"$VERSION\"" "$DIR/latest.json" || die "latest.json is not for $VERSION"
grep -q "https://github.com/$REPO/releases/download/$TAG/RosTalk-Setup-$VERSION.exe" "$DIR/latest.json" ||
	die "latest.json points at another repository or tag; rebuild with RELEASE_REPO=$REPO"
grep -q "^RELEASE_REPO=\${ROSTALK_RELEASE_REPO:-$REPO}\$" "$DIR/install.sh" ||
	die "install.sh was built for another repository; rebuild with RELEASE_REPO=$REPO"

tag_commit=$(git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG^{commit}" 2>/dev/null || true)
head_commit=$(git -C "$ROOT" rev-parse HEAD)
if [ -z "$tag_commit" ]; then
	if [ "$DRY_RUN" = "1" ]; then
		echo "publish-release.sh: note: tag $TAG does not exist yet (a real run needs it):"
		echo "  git tag -a $TAG -m \"RosTalk $VERSION\" && git push origin $TAG"
	else
		die "tag $TAG does not exist: git tag -a $TAG -m \"RosTalk $VERSION\" && git push origin $TAG"
	fi
elif [ "$tag_commit" != "$head_commit" ]; then
	die "tag $TAG is $tag_commit, but HEAD is $head_commit: the release must be built from the tagged commit"
fi

# Pre-releases (1.2.3-rc.1) stay out of /releases/latest, so neither the
# updater nor install.sh picks them up by default.
prerelease=
case "$VERSION" in *-*) prerelease=--prerelease ;; esac

set -- release create "$TAG" --repo "$REPO" --verify-tag --title "RosTalk $VERSION" \
	--notes-file "$NOTES"
[ -z "$prerelease" ] || set -- "$@" "$prerelease"
for name in $FILES; do
	set -- "$@" "$DIR/$name"
done

if [ "$DRY_RUN" = "1" ]; then
	echo "DRY RUN: nothing is sent. A real run would execute:"
	printf '  %s' "$GH"
	for arg in "$@"; do
		case "$arg" in
		*[!A-Za-z0-9._/:=+-]*) printf " '%s'" "$arg" ;;
		*) printf ' %s' "$arg" ;;
		esac
	done
	printf '\n'
	echo "Then check: https://github.com/$REPO/releases/tag/$TAG"
	exit 0
fi

"$GH" auth status >/dev/null 2>&1 || die "gh is not logged in: run gh auth login first (the owner's account)"
"$GH" "$@"
echo "published: https://github.com/$REPO/releases/tag/$TAG"
echo "Updater manifest: https://github.com/$REPO/releases/latest/download/latest.json"
