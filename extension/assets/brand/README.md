# ThreadStack brand assets

Made from the ThreadStack artwork (the stacked-layers mark and the mark with "TS").
`scripts/build-extension.mjs` copies them into the build:

| File | Size | Used for |
| --- | --- | --- |
| `icon-16.png`, `icon-32.png`, `icon-48.png`, `icon-128.png` | 16–128 px | Extension icons (toolbar, extensions page) |
| `threadstack-mark.png` | 128 × 128 | Collapsed rail (shown at 32 px) |
| `threadstack-wordmark.png` | 272 × 116 | Expanded rail (shown at 29 px high) |

The images are 4× their display size so they stay sharp on high-density screens. Larger copies
for documentation are in `doc/assets/brand/` at the repository root. To regenerate them, trim the
transparent margin of the source artwork and resize with a Lanczos filter to the sizes above.
