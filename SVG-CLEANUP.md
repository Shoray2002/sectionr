# Plotter cleanup

Sectionr now cleans the fitted strokes before both preview and SVG export:

- Remove duplicate cubics (including reversed copies) and collinear retraces,
  including partially overlapping straight strokes.
- Join shared endpoints to reduce pen lifts.
- Order strokes by their nearest endpoint, reversing paths when useful. Large
  drawings use a spatial index rather than falling back to page-coordinate order.

Nonlinear cubic control points, pen width, corners and distinct close parallel
features remain intact. The overlap tolerance covers floating-point/export
rounding, not the pen width. No raster skeletonization or additional curve fitting
is used. Visible and hidden ink are cleaned separately.

To clean an existing **Sectionr-exported** SVG without replacing the original:

```sh
npm run clean-svg -- input.svg new-output.svg
```

The tool preserves the physical dimensions, viewBox and stroke attributes, and
reports stroke count and pen-down/pen-up travel in millimetres. It accepts the
unfilled, round M/L/C paths Sectionr exports. Unsupported fills, transforms,
styles, commands or elements fail explicitly; silently removing them would
change the artwork. It refuses to overwrite an existing output file.

`front-slanted.svg` at 300 mm:

| Metric | Before | After |
| --- | ---: | ---: |
| Strokes | 6,506 | 4,236 |
| Pen-down travel | 23.620 m | 23.473 m |
| Pen-up travel between strokes | 242.880 m | 4.427 m |

The dark patches in that SVG are densely packed strokes, **not SVG fills**.
Deleting distinct geometry to lighten those patches would change the picture.
These figures are geometric travel, not a measured plotting time or ink-volume
estimate; controller reordering, motion speeds and pen-lift delays affect the
physical result.

Verification:

```sh
node --test '*.test.js' scripts/clean-svg.test.js
npm run build
```

Before/after 6,000-pixel renders are in the ignored `output/svg-cleanup/` folder.
No added or missing ink was found beyond a one-pixel antialiasing band (0.05 mm
at that render resolution). A physical plot has not been tested.
