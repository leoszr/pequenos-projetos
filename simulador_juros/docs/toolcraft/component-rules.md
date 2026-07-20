# Component Rules

## Control Decision Catalog

Choose controls by product value model before UI appearance.

- Exact owner: if the value model belongs to a built-in, use that built-in.
- Best fit: if multiple built-ins can work, choose one and record the reason.
- Custom escape hatch: use custom controls only after documenting checked built-ins and why the closest one is insufficient.

If a built-in owner is discovered after a custom workaround, replace the workaround with the built-in.

Common exact-owner choices:

- Use `gradient` for adjustable gradients, color transitions, gradient fills, stops, type, and angle. Do not replace it with two `color` controls. The built-in Gradient owns type/angle, the draggable stop track, and the Stops list; the full Gradient control uses content-width internal dividers only when it shares a section with sibling controls, with 18px between each divider and the control content. If Gradient is the first control in that section, only the bottom internal divider renders; if it is last, only the top internal divider renders.
- Use `fontPicker` for typography that includes font family, weight, size, text case, text color/opacity, letter spacing, or line height.
- Use `colorOpacity` when one product entity owns both color and opacity.
- Use `rangeSlider` or `rangeInput` for lower/upper bounds or from/to ranges.
- Use `curves` for editable tone, response, easing, remapping, opacity, depth, mask, or channel curves.
- Use `vector` for position, offset, direction, focus, anchor, light direction, or color-balance pads.
- Use `fileDrop` for source material uploads.
- Use `imagePicker` for choosing one visual option from a set.
- Use `palette` only for constrained design-token color choices with both family and shade: brand palette, Tailwind-like token color, style-guide color scale, semantic palette family, or theme accent token.
- Use `actions` for local section commands that affect only the nearby entity, such as randomize palette, normalize weights, sort glyphs, clear selection, duplicate item, or reset current stop.
- Use `collectionActions` for repeatable product entities whose actual item list can grow or shrink, such as colors, glyphs, symbols, points, rules, variants, object entries, or typography style entries. Use it instead of a count slider when the user edits the actual set. The item list must be runtime state that changes preview/export, not panel-only row chrome. The collection control shows the collection `label` on the left and remove/add icon buttons on the right. Homogeneous repeated items do not show visible per-item labels like `Color 1`, `Color 2`, `Item 1`, or `Item 2` when the collection label already names the group. Item controls should use built-ins such as `color`, `colorOpacity`, `text`, `select`, `segmented`, `slider`, `switch`, `checkbox`, `rangeInput`, or `fontPicker` before any custom renderer. Use `fontPicker` as the item control when each item is a text style or typography entity; do not split its owned fields into neighboring collection controls.
- For a single `actions` button, the control label and the button label must not be identical. Keep the button as the command verb and make the control label a concise one- or two-word context such as `Ink wash`, `Palette action`, or `Current layer`.
- If an `actions` control has a visible label, the label is always above the buttons. Do not use a side-label layout with buttons on the right.
- Actions render in 50% cells: one button uses the left half, two buttons fill one row, and larger groups continue in two columns.
- Do not stretch an odd trailing action full-width or center it; keep it in the left 50% cell.
- Use `panelActions` for sticky final product actions such as export, copy, generate, apply, or download.

When upload/import is part of the source-material flow, `fileDrop` owns the empty/upload state. Do not put a custom pre-upload design, CTA, helper copy, fake sample output, decorative placeholder, or agent-made source preset on the canvas. A default procedural/reference source is allowed only when the prompt or reference explicitly defines it and the worklog records that evidence. If the default source is a file, image, or background image, declare it in `media.defaultAssets` with `sourceTarget` matching the `fileDrop` control so it renders as an attached file rather than a hidden renderer constant.

Small action buttons inside custom controls are for item-level actions such as remove, reorder, add stop, or delete stop. Use schema `actions` for section-level local commands. Keep final product actions in `panelActions`, keep timeline transport in the top timeline, and keep global reset in the controls panel header.

For local reset-like `actions`, use product-specific values such as `reset-current-layer`, `reset-palette`, or `reset-current-stop` and handle them through `ToolcraftApp onPanelAction`. Do not use a bare `reset` value unless the action intentionally runs global `controls.reset`.

## Dividers

- Full-width dividers belong only to panel sections.
- Large built-in compound controls inside a section render content-width internal dividers only when their parent section contains more than one visible control item. Keep 18px between each rendered internal divider and the compound control content. If the compound control is the first item in that section, render only its bottom internal divider and remove the top internal padding. If it is the last item, render only its top internal divider and remove the bottom internal padding. This applies to `gradient`, `fontPicker`, RGB `curves`, `channelMixer`, and `palette`. Single `curves` are one labeled control and do not render internal dividers.
- If a section contains exactly one control, whether simple or compound, render only the parent section dividers.
- Do not add full-width borders inside a compound control, and do not put dividers only around an internal subsection such as Gradient Stops.
- Small compound fields such as `colorOpacity` and `rangeInput` stay inline fields without section dividers.
- `collectionActions` is a compound control when it shares a section with generated item controls, so it follows the same content-width divider rules. Place it at the start of the controlled section. Generated item controls still follow normal density rules: plain colors use equal 50% columns when they fit, while color+opacity items stay stacked.

## Sliders

Slider `step` means numeric snapping only. It does not make a slider visually discrete by itself.

Classify every stepped slider as either `stepped continuous` or `visual discrete` in the spec and schema tests.

Use `variant: "discrete"` for semantic integer domains where markers help choose positions: counts, rows, columns, levels, bands, passes, points, tiles, segments, finite position choices, and finite animation-step controls such as flip depth, character count, glyph steps, or frame steps.

Keep large or precision stepped ranges visually continuous, even with `step`: speed, FPS, rate, duration, seconds, milliseconds, density, size, intensity, quality, and other ranges with many positions.

Visual discrete sliders must declare `step`; the runtime derives one marker per value position from `min`, `max`, and `step`. Visual discrete sliders with too many positions are invalid because they produce marker noise.

Schema sliders always render stacked at full width. Do not put `slider` or `rangeSlider` controls in two-column inline rows. The only built-in exception is `fontPicker`, whose letter-spacing and line-height footer sliders stay paired inside that component.

Use slider `unit` only for real measurement suffixes: `%`, `px`, `°`, `s`, `ms`, `fps`, `rows`, `cols`, or a similarly useful domain unit. Do not use `unit: "x"`; scale, multiplier, intensity, opacity, strength, depth, and shader amount sliders display plain numbers unless a real measurement unit applies. Do not use `unit` to repeat the entity already named by the section or label. Avoid `Letters` + `letters`, `Shape Density / Count` + `shapes`, `Words` + `words`, `Symbols` + `symbols`, `Items` + `items`, `Particles` + `particles`, and `Layers` + `layers`. If the numeric value needs an entity noun to make sense, rename the label or section instead of appending the noun to the value. Compact units render tight (`70%`, `24px`, `8s`); word or acronym units render with a space (`5 cols`, `17 fps`) only when they are truly needed.

Slider value labels are editable only when they contain a numeric value. Textual state labels such as `Normal` are display-only and must not expose hover or click editing affordances.

Range sliders are always full-width two-thumb controls. Do not put a `rangeSlider` in an inline row. Its `defaultValue` must start with different lower and upper values, such as `[20, 80]`, so the control does not collapse into a single-value slider.

Range slider value editing accepts common range separators such as `20/80`, `20-80`, `20 - 80`, `20 80`, and en-dash ranges. Use the built-in parser instead of adding custom label parsing.

Discrete sliders must still drag smoothly. Heavy preview work may be coalesced, cached, or split into lightweight live feedback plus heavier refinement, but the canvas/product output must not stay unchanged until pointer release.

Use `visibleWhen` when a slider or range slider is meaningful only in some mode, type, source, include, variant, or count state. Inactive branches disappear so the panel shows only controls that can be used in the current state.

Do not use schema `disabled: true` or `disabledWhen` for product sliders and range sliders. Product panels should show only controls usable in the current state. Use `visibleWhen` for unavailable product states instead of rendering disabled controls.

For mode/type/source/include/count branches, hide with `visibleWhen` instead of disabling. Example: when Texture is `Off`, hide texture pattern, upload, blend, and opacity. When Texture is `Image`, show the image uploader and shared texture settings. When `Shades` is `2`, `Shade 3`, `Shade 4`, and `Shade 5` are not visible. Do not keep inactive controls visible while making the renderer ignore them.

If `visibleWhen` points to a selector for the same target entity or selected branch, keep the selector and the dependent controls in the same semantic section. A section that exists only because one selector option is active is not a separate product section just because the branch uses a standalone control. Use one section with conditional controls; split only when the dependent branch is a separate product entity with its own workflow and acceptance evidence.

## Palette

Use `palette` only when the product needs a constrained token palette: family plus shade. It is for design-system color tokens, not for arbitrary color entry.

Use `color` for free hex colors, `colorOpacity` when opacity belongs to the same color entity, `gradient` for color transitions, and `fontPicker` when the color belongs to typography. Palette is a live control: family and shade changes update runtime state immediately, before delayed persistence/commit settles, so the next canvas interaction uses the selected token. Browser acceptance must change both `palette.family` and `palette.shade` and prove the rendered/exported output consumes both parts.

## Segmented Controls

Use segmented controls only for compact mode choices that preserve every cell's internal padding.

Segmented controls are full-width. Do not place `segmented` beside Switch, Color, Select, or another control in a two-column inline row; use `select` when a finite choice must occupy a half-width column.

Limits:

- at most four options;
- no option label longer than nine characters;
- no more than twenty-four total option-label characters.

If cells clip, collide, lose padding, or force labels into adjacent cells, shorten labels first. If compact labels still fail, use `select`.

## Select Controls

Standalone `select` controls render stacked and full-width: label above, dropdown below. Do not use the old compact side-label form with label on the left and dropdown on the right.

Use a two-column inline row only for related short `select` pairs that tune one workflow or entity, such as export `Format` and `Resolution`. If either label or selected value clips, truncates, or loses internal padding, stack the pair and record the fit reason.

## Sliders

Slider and range slider controls are live canvas controls. Dragging a thumb must update runtime state and product output while the drag is in progress, not only on pointer release, blur, an Apply action, or a final commit. Browser acceptance should drag the real control and prove the canvas/product observable changes during the interaction.

If live slider updates are slow, fix the renderer path first: update uniforms or stable buffers, cache decoded media and expensive derived inputs, coalesce preview work to `requestAnimationFrame`, cancel stale async renders, move heavy work off React renders, or change renderer strategy. Only in an extreme measured performance ceiling may the app use a degraded live preview or delayed heavy refinement; even then, the user must see immediate canvas feedback during drag and the worklog must record the evidence.

## Sections

Build controls-panel sections from product entities and workflow stages, not component types. Keep sections discrete: two to seven product controls is the normal size. When a section grows past seven controls or mixes several meanings, split it into specific sections such as `Flow Motion`, `Flow Geometry`, `Letter Burst`, `Shape Colors`, `Logo Glow`, `Logo Plate`, or `Text Block`. Do not reuse the same section title for multiple sections.

Section splitting must preserve dependency cohesion. A selector that chooses a mode, type, source, variant, or include state stays with the controls it gates when they share the same product entity. Prefer internal compound-control dividers, tighter labels, or a more specific section title before moving a gated branch into a separate section.

Every app-authored controls-panel body section must have a short meaningful visible title. Runtime-created `Setup` renders as the first visible headerless controls block with no title, reset action, collapse button, or collapsed state; sticky footer action sections use the technical title `Export` but render without a visible heading. Do not omit a title on app-authored body sections to avoid naming decisions; choose the nearest honest product context instead.

Every visible section title renders through the standard 36px collapsible header row with vertically centered text and the runtime collapse icon. Do not hand-build section headers in generated apps.

Section expand/collapse uses the standard runtime height/opacity animation. Do not replace it with instant custom section visibility.

Section collapsed/expanded state persists as a per-app runtime UI preference. It is not undo/redo state, not settings import/export state, and `Reset controls` must not clear it. Runtime `Setup` is not collapsible; sticky footer `Export` sections are not collapsible.

Ordinary section headers expose the runtime section reset action before the collapse button. It dispatches `controls.resetTargets` and restores only that section's control targets to their schema `defaultValue`.

Runtime `Setup` and ordinary controls-panel body sections use 8px top spacing and 24px bottom spacing for their control content. Sticky footer action sections keep their dedicated spacing.

## Colors

First identify the semantic entity the color belongs to: background, object, connector, glow, tone mapping, brand, export, or a named product object.

Keep color inside a section when it configures the same entity as nearby controls. Use a standalone color section only when color is the whole semantic section.

Standalone color section titles must describe product role. Never generate a section titled `Color` or `Colors`. If no meaningful role exists, use a neutral title such as `Appearance` instead of omitting the title.

Decide color label visibility from the user's point of view and apply that decision to the whole semantic group. Omit per-item labels such as `Color 1`, `Color 2`, or `Color 3` when the colors only add variety to one shared palette/color bank such as `Accent Shades`, `Bead Colors`, or `palette.accent1..5`, even if sibling controls like `Spread`, `Mix`, or `Randomness` tune distribution. Do not mix labeled and unlabeled items inside one semantic color bank. Keep visible labels when each color edits a distinct user-facing entity or role, such as `Fill`, `Stroke`, `Background`, `Connector`, `Object`, or `Highlight`.

Multiple related plain colors stay in the same section and render at most two per row. If the bank has an odd trailing plain `color`, the last color still keeps the same half-width footprint instead of stretching to a full row. If any color control has opacity, keep it stacked instead of placing it in a two-column row.

Use `colorOpacity` when one product entity owns both color and opacity, such as text color, shadow color, glow color, overlay color, or stroke color. Do not split that into a separate `color` plus opacity slider/input.

When one short numeric/text field and one plain `color` field configure the same entity, they can share a two-column inline row. Example: `Mask size` and `Color` belong in the same `Mask` row instead of two stacked rows. Do not put `colorOpacity` in inline rows.

Mixed inline rows usually require label parity: every field in that row has a visible label. Toggle-plus-parameter rows are the section-owned exception: keep the `switch`/`checkbox` label visible and set the non-toggle parameter to `label: false`; if the parameter label is needed, stack the controls instead. All 50/50 inline rows use the same horizontal column gap as paired `select` controls; do not give toggle-plus-parameter rows a separate wider or narrower gap. The required `Background` section row uses the switch label `Include` beside the background color parameter with `label: false`. Palette variation color banks are the other exception when the group or section label already names the color bank.

Renderer-owned output background is a base product control. Use a schema `color` target such as `appearance.background` or `scene.background`, add an `export.includeBackground` control for PNG transparency, and make preview/export read those runtime values. Keep them in one required `Background` section directly before the first export settings section. With PNG export, that first section is `Image Export`; with video-only export, it is `Video Export`. Use one equal-width inline row with `export.includeBackground` on the left and `appearance.background` on the right when no other fit rule is violated. The switch label is `Include`, not `Include background`; the background color control uses `label: false`. Each control occupies one half of the row; do not shrink the toggle column to intrinsic width. `export.includeBackground` controls PNG alpha and live preview product-background visibility through `shouldIncludeToolcraftPreviewBackground(state)`; it must not make the Toolcraft canvas shell/backing or video output transparent. Do not hardcode a configurable background in CSS, Canvas `fillStyle`, or WebGL clear color.

## File Upload

Use `fileDrop` for source material uploads in the controls panel. Do not place upload UI on the canvas.

Use `assetKind: "image"` for image-only source uploads and `assetKind: "file"` for arbitrary uploaded files. Image mode accepts images only by default. File mode accepts any file by default unless `accept` narrows the allowed extensions or MIME types.

In single-layer apps, the runtime shows uploaded image preview and clear button in the file control. Clearing removes the attached source from the renderer and canvas. Global Reset controls and section reset restore `media.defaultAssets` for that fileDrop target; when no default asset exists, reset removes uploaded source material and returns the fileDrop target to `defaultValue`. If users can delete/reorder/transform predefined attached files and that state should survive reload, include `"media"` in schema persistence.

In image mode, the runtime owns image transform actions directly below the uploader: `90° Right`, `Flip horizontal`, and `Flip vertical`. They render through the built-in actions-control in one three-column row with compact visible labels: `90°`, `Flip H`, `Flip V`; keep a 6px vertical gap between the uploader and action row. Do not create a custom image action button grid. With exactly one uploaded image, those actions are visible immediately. With multiple uploaded images, the user selects a thumbnail first; until then the actions are hidden, and once shown they apply only to the selected image. Product preview/export must consume `state.mediaAssets[].transform` rather than keeping separate image transform state.

The FileDrop panel preview is not product canvas rendering. It keeps a stable preview frame across rotate/flip actions and contains the transformed bitmap inside that frame, so horizontal or vertical uploads are never cropped by the control preview. Canvas/product renderers may still use cover/crop when the uploaded image is source material.

Use `multiple: true` when the app needs several uploaded images as one source set. The runtime appends media, switches to a sortable four-column thumbnail grid when more than one image is present, puts the add-more tile last, and keeps per-image removal inside the file control. Dragging thumbnails updates runtime media order; preview, export, and renderer mapping must consume that order instead of keeping a separate product-only order.

In file mode, uploaded files render as a sortable list with a paperclip icon, filename, remove button, and `--border/5` separators. Do not build custom file lists, custom upload buttons, or custom sorting for generic source files when `fileDrop` can represent the source set.

When an app contains both image and file uploaders, canvas drops route by asset kind. Image files prefer visible image uploaders; non-image files prefer visible file uploaders; file uploaders may accept images only when no image uploader matches. Product renderers must consume `state.mediaAssets` filtered by `sourceTarget` and runtime media order.

When uploaded images are used as canvas/background source material, use `editable-output`, draw them with cover/crop behavior, scale proportionally until the current canvas bounds are fully covered, leave canvas dimensions and Setup controls unchanged, and crop overflow at the canvas bounds.

In multi-layer apps, deletion and visibility belong to the Layers panel; `fileDrop` stays an upload target.

## Image Picker

Every visible `ImagePicker` item must be actionable in the current product context. Do not show choices that sanitize to fallback or no-op behavior.

Sizing:

- two options: large tiles;
- three or six options: medium tiles;
- larger sets: small tiles.

Filter or split choices by template, mode, or selected object when only some choices are valid.

## Font Picker

Use `fontPicker` for typography choices that need font preview plus weight, size, text-case, text color/opacity, letter-spacing, and line-height controls. Do not recreate it with a plain `select`, custom font list, or separate typography inputs.

The value is one object: `{ fontId, fontWeight, fontSize, letterSpacing, lineHeight, textCase, color, opacity }`. Typography renderers and exports must consume all eight parts.

The standard/default text color is `#FFFFFF` with opacity `100`. Omit `color`/`opacity` or use those values unless the prompt or reference explicitly requires a different initial text color.

If `fontPicker` controls product text, the preview renderer and export renderer must apply the selected `fontId`, `fontWeight`, `fontSize`, `letterSpacing`, `lineHeight`, `textCase`, `color`, and `opacity` to that actual text. Do not stop at updating runtime state, the select label, or the popup preview.

The component owns search, category filters, virtualized scrolling, font preview loading, selected-row behavior, the font-weight select, the font-size input, the text-case select, the color/opacity control, and the two footer sliders. Browser acceptance must choose a different font, change weight, change size, change text case, change color/opacity, move Letter spacing, and move Line height.

`fontPicker` is an atomic typography block. Do not place sibling schema controls for `Case`, `Weight`, `Size`, `Letter spacing`, `Line height`, `Color`, or `Opacity` when they affect the same product text entity. If a typography part is missing from the built-in value model, extend `fontPicker` in the kit instead of composing a neighboring control.

Do not add `description` to `fontPicker` just to list these owned fields. If the section title and visible field labels already make the text target clear, omit `description`; use it only for non-obvious product scope.

## Vector

One vector control in the controls panel uses the square X/Y pad. Multiple vector controls use compact pads so the sidebar does not become too tall.

Use variants by product meaning:

- default: position, offset, direction, focus, anchor, light direction;
- `whiteBalance`: temperature and tint;
- `colorBalance`: paired color-balance axes;
- `chromaOffset`: RGB or chromatic offset;
- `toneBias`: split-tone, duotone, or color-grading bias.

Use Vector only when the user is meant to manually author a stable two-axis product parameter. Do not expose a pad for current animation state, keyboard movement, pointer movement, physics state, timeline phase, velocity, target pose, current pose, or simulated position/direction just because the internal value has `x` and `y`.

Before adding a Vector control to an animated or interactive product, classify movement ownership:

- `direct-authored`: a stable parameter the user manually edits, such as light direction, focus, anchor, or object offset. This can be Vector.
- `timeline-driven`: movement comes from playback/keyframes. Use timeline, speed, duration, path, step, or amplitude controls instead.
- `keyboard/pointer-driven`: movement comes from user input on the canvas/app. Keep position/direction in interaction state and expose only useful tuning controls.
- `simulation-owned`: movement comes from physics/procedural state. Keep current pose/velocity internal and expose high-level tuning controls.

Default/spatial vector pads use screen-coordinate movement. Dragging the pad left/up lowers `vector.x` and `vector.y`, so an object on the canvas moves left/up without renderer-side Y inversion. Use `coordinateMode: "cartesian"` only when the product intentionally exposes mathematical Y-up coordinates.

Vector pad value labels are compact UI labels, not raw state dumps. They show rounded normalized coordinates and must never expose floating-point tails such as `-0.07070312499999998`.

Double-clicking the vector pad resets both axes to the control default through the normal runtime value update, matching the reset button in the section header. If no default is defined, the fallback is `0,0`. Do not add a separate custom reset button for basic pad reset behavior.

Holding Shift while dragging a vector pad locks movement to the dominant axis and must not select text or page content. Use the built-in `vector` control for constrained two-axis direct-authored parameters instead of creating a custom pad.

Do not add custom vector sizing props. Choose the right number, variant, and section grouping, then let runtime sizing handle the pad.

## Curves

Use `curves` for editable remapping curves. First decide the curve variant by product meaning; do not rely on the runtime default.

Use `variant: "single"` for one standalone curve without channel tabs, such as acceleration, bend, easing, opacity response, depth response, mask response, threshold response, tone response, or another single mapping curve. Do not create a custom curve UI just to remove RGB tabs.

RGB Curves is the color-correction or channel-specific case. Use RGB/R/G/B tabs only when the product edits RGB channels, color correction, color grading, or channel curves. Do not force RGB/R/G/B tabs onto products that need only one response, bend, depth, or easing curve.

Single Curves is one labeled control and does not use internal dividers. RGB Curves is the compound variant because it contains channel tabs plus curve points, so it follows the compound divider rules when mixed with sibling controls.

Choose interpolation by product meaning:

- `interpolation: "smooth"` for photo/editor-like visual tone, color, and RGB curves where the curve should feel like a creative spline;
- `interpolation: "monotone"` for depth, response, mask, opacity, threshold, and data-mapping curves where order must be preserved and overshoot is unsafe.

Single curves default to monotone. If a single curve is still a creative visual tone curve, set `interpolation: "smooth"` explicitly.

Acceptance for curves should include an off-center control point near an edge so smooth-vs-monotone interpolation mistakes are visible in the actual product output, not only in the curve UI.

## Text And Code

Use `text` for short single-line strings: button labels, canvas labels, names, small values, compact prompts, titles, captions, badges, and tokens.

For `text`, separate content from settings. `commitMode` defaults to `"content"`: content strings such as prompts, names, titles, tokens, and short text update while the user types. Use `commitMode: "setting"` for text inputs that edit settings such as font size, numeric-like style values, dimensions, ids, or configuration fields; setting text commits on blur or Enter. Canvas width and Canvas height are runtime-owned editable-size fields and always commit on blur or Enter.

Use `code` / `CodeTextarea` as the base multiline content editor for any potentially long value: long prompts, multiline text, instructions, JSON, CSS, shader code, scripts, templates, or other structured text. It applies while typing, is capped at 12 visible lines, and long content scrolls inside the textarea instead of making the controls panel taller. Do not use it for short one-line button/canvas text such as `Glass`, `Submit`, `Title`, or `Badge`; use `text`. If the default value is short but the intended input is long or structured, make that reason explicit in `description`. Do not name a section `Code` unless the product value is actually code.

## Labels

Visible control labels should be short UI names, usually one to three words. Do not put explanations, formulas, units, parenthetical hints, or usage instructions in field labels.

Short labels must still be semantically sufficient with nearby context. `Animation` / `Speed` is fine because the section names the entity; `Settings` / `Speed` should become `Animation speed`, and mixed visual buckets should use labels such as `Symbol color` or `Background opacity`.

Visible control labels can get a runtime-owned filled Phosphor question tooltip icon. Put a concise product-specific explanation in `description` only when it adds meaning beyond the label. Do not write recaps like `Adjusts Opacity`, and do not build custom help icons beside built-in labels.

Do not add `description` to obvious color clusters. If a section title already names the palette/color context, sequential labels such as `Color 1`, `Color 2`, or simple palette controls such as `Spread` do not need help icons. Keep the whole obvious group clean unless the tooltip explains a non-obvious product behavior.

For compound controls such as `fontPicker`, `description` must not enumerate owned fields like font, weight, size, case, color, opacity, letter spacing, or line height. The component already labels those fields.

If a source label is unavoidably long, keep the visible label concise and rely on native `title` for the full text.

Switch and checkbox labels name the setting context, not the action. Do not prefix them with `Enable` or `Disable`; use `CRT`, `Glow`, `Loop`, or `Guides` instead of `Enable CRT` or `Disable guides`. If the section title already names the setting context, do not repeat that title as the visible toggle label; use a short contextual label such as `Include` or, only for icon-only visual toggles, `label: false` with the meaning in `target` and `description`.

Two adjacent `switch` or `checkbox` controls for the same product entity must share one inline row when every visible label fits without truncation. Use short one- or two-word labels such as `Snap X` and `Snap Y`, or `Glow` and `Loop`. The runtime auto-pairs safe adjacent toggles by target entity; use explicit layout groups only when pairing a toggle with a non-toggle parameter. If either label would truncate in half-width, remove the inline group and let the toggles stack.

A single `switch` or `checkbox` may share an inline row with one related parameter control when the toggle label fits and the controls edit the same entity. This row is always equal-width: each control occupies one half, using the same horizontal column gap as a paired `select` row. The non-toggle parameter uses `label: false`; if that parameter label is needed for clarity, stack the controls instead. Example: `Loop` plus an unlabeled duration field, or `Include` plus unlabeled background color inside the required `Background` section. If the section title already names the toggle context, shorten the toggle label instead of repeating the title.

## Layers

Enable layers only when the app has multiple editable objects, media objects, groups, visibility, selection, reorder, or selected-layer controls.

Do not show Layers for a single-layer app. Do not use `selectedLayer.*` targets when Layers are disabled.

When Layers are enabled, browser tests must use the real LayersPanel UI: select, visibility, reorder, grouping, and media lifecycle when uploads/deletes create or remove layers.

## Timeline

Before choosing timeline mode for an animated product, write an Animation Intent Inventory:

- `timeline-playback`: user-facing play, pause, scrub, duration, loop, restart, progress, export-at-time, or video export.
- `timeline-keyframes`: editable diamonds, rows, easing, or keyframe evaluation.
- `autonomous`: decorative or self-running output with no user-facing transport and no video export.

Product output animation uses the top Toolcraft timeline. Use no timeline only for non-product autonomous decorative/self-running motion without video export, and declare `appTransferMode.animationIntent.mode = "autonomous"` with coverage proving no play/pause, scrub, duration, loop, export-at-time, product animation, or video export behavior.

Use playback timeline for play, pause, scrub, duration, loop, restart, export-at-time, or video export.

When `panels.timeline` is enabled for a new Toolcraft app, `appTransferMode.animationIntent` must match it: `mode: "timeline-playback"` for playback, or `mode: "timeline-keyframes"` for keyframes.

Playback renderers must read `state.timeline.currentTimeSeconds`, `state.timeline.durationSeconds`, `state.timeline.isPlaying`, and loop state from the runtime. The full animation cycle must span `state.timeline.durationSeconds`; do not hard-code a separate local animation duration such as 3s or 8s inside the renderer.

Product animation loop means a seamless forward-only cycle by default. Motion advances in one direction, the first and last frames stitch without a visible jump, and mirror, yoyo, ping-pong, or reverse loops are allowed only when the user explicitly requests that behavior as a product mode.

When the product has a known loop duration, declare it as `panels.timeline.defaultDurationSeconds`; the runtime timeline starts from that loop duration instead of an unrelated 8s default. Timeline animation intent must also declare `loopDuration` with `source`, `seconds`, and `evidence`. Valid sources are `reference`, `user-request`, and `product-derived`; runtime/template fallback 8s is not a valid source. `panels.timeline.defaultDurationSeconds` must match `animationIntent.loopDuration.seconds` so the initial timeline UI shows the declared product loop. Renderers may compute an initial loop duration default during app initialization or reset, but they must not watch `state.timeline.durationSeconds` and dispatch `timeline.setDuration` back to a computed local value. Once the user edits the timeline duration, that runtime value is the loop duration source of truth and renderer progress must map into it. Use `getToolcraftTimelineLoopTime` or `getToolcraftTimelineLoopProgress` to derive loop phase from `state.timeline.currentTimeSeconds` and `state.timeline.durationSeconds`; do not hand-roll wall-clock, fixed-duration, mirror, yoyo, ping-pong, or reverse phase math. Changing duration must preserve seamless forward-loop semantics: one complete cycle maps from `0` to `state.timeline.durationSeconds`, the first and last frames still stitch, direction does not reverse, and the renderer must not switch to wall-clock time or a fixed local duration.

For reference-runtime-clone apps that map reference transport to the Toolcraft timeline, the same duration proof lives on `appTransferMode.referenceTimeline.loopDuration`. `referenceTimeline.mode: "toolcraft-playback"` or `"toolcraft-keyframes"` must declare `loopDuration` with source, seconds, and evidence, and `panels.timeline.defaultDurationSeconds` must match it. Do not let a reference clone inherit the runtime/template 8s default unless the reference or user request actually proves an 8s loop.

Use keyframes timeline for diamonds, editable rows, easing, or keyframe evaluation. In keyframes mode, Toolcraft infers capable controls; do not manually hide diamonds on controls that can be keyframed.

Keyframe state stores typed control values. `valueLabel` is display-only for the timeline UI; renderers and tests must never parse it as the source of truth. Custom renderers must read keyframed settings through `evaluateToolcraftTimelineValues`, `evaluateToolcraftTimelineValue`, `useToolcraftEvaluatedValues`, or `useToolcraftEvaluatedValue` instead of reading raw `state.values` for keyframed targets.

Playback-only timelines stay collapsed and must not show control diamonds or expanded keyframe rows.

When non-looping playback reaches the end, pressing Play again must restart from time 0. Do not require users to scrub back manually before replaying.

App-wide Play, Pause, Animate, and Restart controls do not belong in the right panel.

Right-panel animation controls may tune renderer parameters such as mode, intensity, speed, or stagger only after the animation intent is declared. They must not replace top timeline transport.

Do not replace `TimelinePanel` with an app-level playback, transport, or timeline panel to avoid runtime performance issues. Keep the runtime panel design and fix the Toolcraft runtime clock/state path. Use custom timeline UI only for explicit `custom-reference-timeline` transfers with browser-backed reference timeline coverage.

## Panel Actions

Use `panelActions` only for sticky footer product actions such as Generate, Apply, Export, Copy, or Download.

Generated apps keep a controls panel so runtime `Setup` is visible from the first run. Settings import/export is mandatory runtime `Setup` behavior there; do not add Import Settings or Export Settings to sticky footer `panelActions`; the runtime inserts them in the first visible headerless `Setup` controls block and imports/exports control values, canvas size, and timeline state.

Do not gate settings import/export by complexity thresholds, app size, or prompt wording. Use schema `settingsTransfer` only to customize exported JSON identity or file name.

When editable-output canvas sizing is enabled, the first `Setup` runtime section contains `Export Settings`, `Import Settings`, `Aspect ratio`, `Canvas width`, `Canvas height`, optional `Resolution scale`, and optional `Timeline` in that order. Do not split these into separate app-authored sections, rename the controls, rebuild the block by hand, or declare runtime Setup targets in product sections. App-authored controls targeting `runtime.settingsTransfer`, `canvas.aspectRatio`, `canvas.size.width`, `canvas.size.height`, `canvas.renderScale`, or `panels.timeline.extended` are invalid and never suppress the mandatory runtime controls.

If only `Export Settings` and `Import Settings` appear in that section, the schema is not using `editable-output` canvas sizing. For product-output apps, fix the canvas sizing decision instead of adding hand-built size fields. A reference, previous app, fixed-format baseline, or user-provided default size does not justify hiding size controls; keep those dimensions as editable `canvas.size` defaults.

Manual `Canvas width` or `Canvas height` edits are exact output-size edits. They keep the other dimension unchanged, switch `Aspect ratio` to `Custom`, and update the custom ratio inputs to the reduced current ratio. Do not recreate the old behavior where typing one size field stays locked to the previous aspect preset.

Enable `canvas.renderScale: true` for non-vector raster previews such as Canvas 2D, WebGL, or WebGPU output. Runtime adds a `Resolution scale` slider after canvas sizing; it defaults to `2` and lets users trade preview quality/performance without changing output size. Adding or enabling this slider requires targeted browser evidence that the canvas stays responsive while dragging sliders or other high-frequency controls at the selected scale. A full browser performance checkpoint is required for the first working product version and explicit performance complaints; use the agent-controlled browser first and `npm run verify:perf` only as fallback. Performance fixes must preserve the selected scale and keep canvas preview responsive. Diagnose the actual bottleneck before lowering quality; do not silently downsample, stretch a lower-resolution backing canvas, blur output, or clamp `canvas.renderScale` below the user's chosen value. Do not enable it for DOM/SVG/vector-native previews.

When `panels.timeline` is enabled, runtime adds a `Timeline` switch as the last Setup control. It is a runtime presentation preference only: off shows compact Play-only transport, on shows the extended TimelinePanel with scrubber, duration, loop, and keyframe UI. It does not change playback, keyframes, export, product values, settings transfer, or Reset controls. `persistence.include: ["panels"]` may restore it. If `panels.timeline` is omitted, the Timeline switch must not be shown.

Reset belongs to the controls panel header reset button. Do not add a footer action with `label`, `value`, or `command` containing reset; acceptance treats that as a duplicate Reset.

Still-output product apps include one primary `Export PNG` action.

Animated product apps include `Export Video` as the primary action and `Export PNG` as the secondary action.

Export-labeled footer actions use `icon: "upload-simple"`, matching the runtime `Export Settings` button. Do not use `download`, `download-simple`, or `export` icons for `Export PNG` or `Export Video`.

Every product app with `Export PNG` includes a separate `Image Export` section. That section must contain:

- `export.image.format` as a `select`, with default value `png` and baseline options `png` and `jpg`;
- `export.image.resolution` as a `select`, with default value `4k` and baseline options `2k`, `4k`, and `8k`.

Place `Image Export` directly above sticky footer export buttons for still-output apps. For animated apps with both PNG and video export, place `Image Export` immediately before `Video Export`. `Format` and `Resolution` are one compact workflow pair: render them in a two-column inline row by default. Do not use `segmented` for this pair; it must visually match the Video Export dropdown structure.

Animated product apps with `Export Video` must enable the top Toolcraft timeline and include a separate `Video Export` section. That section must contain:

- `export.video.format` as a `select`, with default value `mp4` and baseline options `mp4` and `webm`;
- `export.video.resolution` as a `select`, with default value `current` and options such as `current` and `4k`.

Place `Video Export` as the final authored controls section directly above sticky footer export buttons. `Format` and `Resolution` are one compact workflow pair: render them in a two-column inline row by default. Use stacked rows only when a label or selected value would clip, truncate, or lose internal padding, and record that fallback reason in the spec or worklog. Do not use `segmented` for this pair unless the product has a deliberately tiny fixed output menu and browser tests prove every cell keeps padding.

Do not put video export format/resolution controls inside effect, renderer, animation, or output-background sections. `MOV` and `ProRes` are not baseline browser outputs; use them only with an explicit encoder/transcoder and dedicated acceptance plus performance coverage. Video exporters use `getToolcraftVideoExportSize`; do not hand-roll `4096` long-edge sizing for video. The `current` video option uses the current canvas/output size with even encoder-safe rounding. The `4k` video option fits inside 3840x2160, preserves aspect ratio, and returns even encoder-safe dimensions. Recorder/encoder errors must reject the export Promise instead of producing a corrupt blob.

Add `Copy PNG` only when clipboard output is part of the product. Copy never replaces export. If two footer actions are needed, secondary/outline goes left and primary goes right. Footer actions must be one compact horizontal group, not stacked full-width rows. If an odd number of actions leaves one action alone in the final row, that final action spans the full row.

Async footer actions return the real Promise from `ToolcraftApp onPanelAction`. Export, download, copy, generate, and apply must not run as fire-and-forget work; the runtime uses the returned Promise to show the sticky footer top accent indicator only while the operation is pending. Use `reportProgress(0..1)` from `onPanelAction` for determinate progress. Video export reports frame-based render/encode progress, and PNG export reports phase progress when render/blob/handoff are asynchronous.

Do not place product action buttons on the canvas or in the renderer.

## Canvas Handles

Use product editing handles only when direct manipulation is better than panel-only editing: gradient stops, focus points, light vectors, crop bounds, mask points, transforms, bezier anchors, or perspective corners.

Handles are visual overlays, not app UI. They must be textless, tokenized, bound to runtime state, and excluded from export/copy output.
