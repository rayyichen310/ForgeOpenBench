#!/usr/bin/env bash
# Generate docs/collage.png from all PNG screenshots in docs/images/.
# Ignores subdirectories (e.g. docs/images/old versions/). Run from repo root.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$script_dir"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

readarray -t files < <(find images -maxdepth 1 -type f -name '*.png' | sort)
if [ ${#files[@]} -eq 0 ]; then
  echo "No PNG images found in docs/images/" >&2
  exit 1
fi

scaled=()
for f in "${files[@]}"; do
  out="$tmp/$(basename "$f")"
  # Resize to a uniform width, keep aspect ratio.
  magick "$f" -resize 500x "$out"
  scaled+=("$out")
done

# Tile into a grid. Columns chosen so the final image is reasonably wide.
# With 20 screenshots, a 5x4 grid matches the previous landscape collage shape.
cols=5
magick montage "${scaled[@]}" \
  -set label '%f' \
  -mode concatenate \
  -tile "${cols}x" \
  -geometry +12+12 \
  -background white \
  -pointsize 14 \
  -fill '#333333' \
  collage.png

echo "Generated docs/collage.png from ${#files[@]} images."
