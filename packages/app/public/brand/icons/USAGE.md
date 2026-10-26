# UI icons

66 icons in one sprite, `icons.svg`. Each symbol is on a 24-unit grid with 1.8-unit strokes, round caps and joins,
drawn in `currentColor`; use them at 20–24 CSS pixels. Symbol ids are `mmr-<name>` (`mmr-save`, `mmr-launch`,
`mmr-motor`, …).

```html
<svg class="mmr-icon" aria-hidden="true"><use href="/brand/icons/icons.svg#mmr-save"/></svg>
<button class="mmr-button mmr-button--quiet" aria-label="Save rocket">
  <svg class="mmr-icon mmr-icon--sm" aria-hidden="true"><use href="/brand/icons/icons.svg#mmr-save"/></svg>
</button>
```

The sprite must be served from the same origin as the page (external `<use>` references do not work cross-origin
or from `file://`). Put the accessible name on the button or link, not on the icon. Individual SVG/PNG exports of
each icon are in the Dropbox archive (v4 `03-ui-icons/`) if a non-web use needs them.
