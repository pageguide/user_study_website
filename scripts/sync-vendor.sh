#!/usr/bin/env bash
# Keep the vendored module identical to the extension's.
#
# WHY A COPY AT ALL: the site and the extension must ask the same questions, strip the arms the same
# way and score the same way. If the website reimplemented any of that, the two would drift — an id
# differing by one character scores as a different answer — and nothing would fail until analysis,
# by which point the data is already collected.
#
#   ./scripts/sync-vendor.sh          check the copy is current (exit 1 if not)
#   ./scripts/sync-vendor.sh --write  update the copy from the extension
#
# Point PAGEGUIDE_DIR at the extension checkout if it is not the default sibling location.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PAGEGUIDE_DIR="${PAGEGUIDE_DIR:-$HOME/Downloads/pageguide}"
SRC="$PAGEGUIDE_DIR/sidepanel/guide_trajectories.js"
DEST="$HERE/vendor/guide_trajectories.js"

if [ ! -f "$SRC" ]; then
  echo "✗ Cannot find the extension's module at: $SRC"
  echo "  Set PAGEGUIDE_DIR to your pageguide checkout and try again."
  exit 2
fi

if [ "${1:-}" = "--write" ]; then
  cp "$SRC" "$DEST"
  echo "✓ Vendored $(basename "$SRC") from $PAGEGUIDE_DIR"
  exit 0
fi

if diff -q "$SRC" "$DEST" >/dev/null 2>&1; then
  echo "✓ vendor/guide_trajectories.js matches the extension"
  exit 0
fi

echo "✗ vendor/guide_trajectories.js has DRIFTED from the extension."
echo "  The site and the extension would ask different questions or score differently."
echo
diff "$DEST" "$SRC" | head -40
echo
echo "  Run ./scripts/sync-vendor.sh --write to update the copy, then re-test the site."
exit 1
