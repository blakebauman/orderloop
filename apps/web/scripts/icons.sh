#!/usr/bin/env bash
# Renders the Home Screen and manifest icons in public/ from the favicon's mark: ink on Ledger
# paper, opaque (iOS fills transparency with black). The mark sits inside the central 60%, so the
# same art also works as a maskable icon. Needs rsvg-convert (brew install librsvg).
set -euo pipefail
cd "$(dirname "$0")/../public"
art='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#f9f5ee"/><g transform="translate(4.8 4.8) scale(0.6)" fill="none" stroke="#232b3d" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-3.1-6.3"/><path d="M17.5 2.5v4h-4"/><rect x="9" y="9" width="6" height="6" rx="1" fill="#232b3d" stroke="none"/></g></svg>'
for size in 180 192 512; do
  name=$([ "$size" = 180 ] && echo apple-touch-icon.png || echo "icon-$size.png")
  printf '%s' "$art" | rsvg-convert -w "$size" -h "$size" -o "$name"
done
