# Schema Reference

Edit `src/app/app-schema.ts` as the public product surface.

## Runtime Shape

- Use `defineToolcraft`.
- Configure `canvas`, `panels`, `toolbar`, and `panelActions` through the schema instead of composing those surfaces by hand.
- New generated apps keep a controls panel so runtime `Setup` always provides `Export Settings` / `Import Settings` from the first run.
- Bind every control to a schema `target`.
- Use `defaultValue` for reset behavior.
- Use `description` for product-specific help beside a visible label. Keep `label` short. Omit `description` instead of writing label recaps like `Adjusts Opacity`; also omit it for obvious color clusters such as `Color 1` / `Color 2` inside a color section. Compound controls such as `fontPicker` must not use `description` to list their own fields.
- Use `visibleWhen` when a control or section exists only for a specific template, type, source, include state, mode, variant, or count. Hidden values are preserved. A section with no visible controls is hidden automatically.
- Do not use `disabled: true` or `disabledWhen` for generated product controls. Product panels should show only controls usable in the current state. Runtime primitives may still have disabled styling internally, but app schemas should model product availability with `visibleWhen`.
- Conditions support `equals`, `notEquals`, `oneOf`, `notOneOf`, `greaterThan`, `greaterThanOrEqual`, `lessThan`, and `lessThanOrEqual`.
- Use `orderRole` to make control order testable.
- Use `performanceRole` and `performanceReason` on every visible non-action control so performance coverage can be derived from the schema.
- Use built-in controls before custom renderers.
- Use `panelActions` only for sticky footer product actions.
- Do not use `panelActions` for settings import/export; `settingsTransfer` owns that body section.
- Do not use `panelActions` for reset. The controls panel header owns reset, and footer actions with `label`, `value`, or `command` containing reset fail acceptance.
- Use `media.defaultAssets` for predefined file/image attachments; never hard-code those files inside `canvasContent` or the renderer.
- Still-output product apps expose `Export PNG`.
- Animated product apps expose `Export Video` and `Export PNG`.
- Export PNG and Export Video use `icon: "upload-simple"` to match the runtime `Export Settings` action.
- `Copy PNG` can be secondary, but it never replaces export.
- If an odd number of footer actions leaves one action alone in the final row, that final action spans the full row.
- Use `ToolcraftApp onPanelAction` for product-specific actions.
- Async export/download/copy/generate/apply handlers return the real Promise from `onPanelAction`; the runtime shows the sticky footer top accent indicator only while that Promise is pending and fills it from `reportProgress(0..1)` when determinate progress is available.
- Do not duplicate runtime-owned canvas, toolbar, panel, layer, or timeline internals.

## Export

Use the standard export helpers from `@/toolcraft/runtime`.

```ts
export: {
  png: {
    background: "include",
  },
}
```

`export.png.background` defaults to `"include"`. Product apps still expose runtime controls for the actual user choice:

- `appearance.background` or `scene.background` as a `color` control;
- `export.includeBackground` as a boolean/options control.

PNG exporters should call `createToolcraftPngExportCanvas({ background, includeBackground, resolution, state, render })`, where `background`, `includeBackground`, and `resolution` come from runtime state. Live preview renderers should call `shouldIncludeToolcraftPreviewBackground(state)` and hide only the product-rendered background when it returns false; do not hide or replace the Toolcraft canvas shell/backing. For every app with `Export PNG`, `resolution` comes from `export.image.resolution`: `2k`, `4k`, and `8k` render actual 2048/4096/8192px long-edge PNGs. `current` or omitted resolution falls back to retina sizing. Video export always includes the product background, uses `getToolcraftVideoExportSize({ resolution: state.values["export.video.resolution"], state })`, and must prove exported metadata duration matches the runtime timeline duration.

Every app with `Export PNG` exposes a separate `Image Export` controls section. For still-output apps it sits directly above sticky footer actions. For animated apps with both `Export PNG` and `Export Video`, it sits immediately before `Video Export`:

```ts
{
  title: "Image Export",
  controls: {
    imageFormat: {
      defaultValue: "png",
      label: "Format",
      options: [
        { label: "PNG", value: "png" },
        { label: "JPG", value: "jpg" },
      ],
      target: "export.image.format",
      type: "select",
    },
    imageResolution: {
      defaultValue: "4k",
      label: "Resolution",
      options: [
        { label: "2K", value: "2k" },
        { label: "4K", value: "4k" },
        { label: "8K", value: "8k" },
      ],
      target: "export.image.resolution",
      type: "select",
    },
  },
  layoutGroups: [
    {
      layout: "inline",
      columns: 2,
      controls: ["imageFormat", "imageResolution"],
    },
  ],
}
```

Animated apps with `Export Video` must enable the top Toolcraft timeline and also expose a separate `Video Export` controls section. Do not mix video export settings into renderer/effect sections. Place this section after `Image Export` as the final authored controls section directly above sticky footer export buttons. `Format` and `Resolution` are a compact semantic pair, so use an inline two-column layout by default; stack them only when labels or selected values would clip.

```ts
{
  title: "Video Export",
  controls: {
    videoFormat: {
      defaultValue: "mp4",
      label: "Format",
      options: [
        { label: "MP4", value: "mp4" },
        { label: "WebM", value: "webm" },
      ],
      target: "export.video.format",
      type: "select",
    },
    videoResolution: {
      defaultValue: "current",
      label: "Resolution",
      options: [
        { label: "Current", value: "current" },
        { label: "4K", value: "4k" },
      ],
      target: "export.video.resolution",
      type: "select",
    },
  },
  layoutGroups: [
    {
      columns: 2,
      controls: ["videoFormat", "videoResolution"],
      layout: "inline",
    },
  ],
}
```

Use `MediaRecorder.isTypeSupported(...)` or an explicit encoder/transcoder capability check before choosing the actual MIME/container. `MOV` and `ProRes` are not baseline browser outputs; use them only with a custom encoder/transcoder and dedicated acceptance plus performance coverage. `4K` is an export resolution target, not a reason to lock `canvas.size` and not PNG-style 4096px long-edge sizing. Use `getToolcraftVideoExportSize`: `current` uses the current canvas/output size with even encoder-safe rounding, while `4k` fits inside an encoder-safe 3840x2160 box, preserves aspect ratio, and returns even pixel dimensions. Set recording canvas dimensions before `captureStream`, `MediaRecorder`, `VideoEncoder`, or equivalent setup, and reject recorder/encoder errors instead of returning corrupt blobs. Offline rendered-frame video export must write timeline-based timestamps; `canvas.captureStream()` plus `MediaRecorder` records wall-clock time and cannot be the only duration mechanism for heavy renderers.

## Canvas Sizing

Choose sizing from product context:

- `intrinsic-media`: an explicit media-viewer/source-native product where a single uploaded or generated source defines `canvas.size`.
- `editable-output`: product/export output where users always see aspect ratio, width, and height.
- `fixed-output`: non-product/internal output size that users must not edit.

For product output, export, copy, download, shader rendering, procedural rendering, reference clones, or no single intrinsic source image, use `editable-output`. Upload without explicit sizing also resolves to `editable-output`.

An uploaded background/source image inside a product canvas is not source-native sizing. Use `editable-output`, keep the current `canvas.size`, keep `Setup` canvas controls visible, and render the image as cover/crop inside the current canvas bounds without letterbox or aspect distortion. Use `intrinsic-media` only when the product is truly a media viewer/source-native tool where imported media natural dimensions intentionally own `canvas.size`, and prove that with `canvasSizingCoverage: "intrinsic-media-size"` acceptance.

A prompt-provided, reference, fixed-format, or base/default size is only the initial `canvas.size`. It must not remove the runtime Aspect ratio, Canvas width, and Canvas height controls. Aspect presets use canonical output sizes (`16:9` is `1920x1080`; the other presets are derived around a 1080px short edge or matching portrait long edge). When no explicit product size is provided, runtime defaults to `16:9` / `1920x1080`; choose another preset only when the product meaning calls for it. Generated product/export apps do not use `fixed-output` to preserve a reference baseline; fixed dimensions stay visible as editable defaults.

Resolved `canvas.size` exists for every canvas app, but visible `Aspect ratio`, `Canvas width`, and `Canvas height` controls are mandatory through `editable-output` sizing for product/export apps. They live in the first visible headerless `Setup` controls block after `Export Settings` and `Import Settings`. Do not hand-build a duplicate size selector.

When the user manually edits `Canvas width` or `Canvas height`, the runtime treats that as an exact custom output size. It keeps the typed dimension, keeps the other dimension unchanged, switches `Aspect ratio` to `Custom`, and shows the reduced current ratio in the custom ratio inputs. Only selecting an aspect preset may resize both dimensions from a canonical preset.

For non-vector raster, Canvas 2D, WebGL, or WebGPU previews, set `canvas.renderScale: true`. Runtime appends `Resolution scale` after canvas sizing in `Setup`. The slider ranges from `1` to `2`, defaults to `2`, and changes the renderer backing pixels without changing the visible CSS size or product output dimensions. Adding or enabling this slider requires targeted browser evidence that the canvas stays responsive while dragging sliders or other high-frequency controls at the selected scale. A full browser performance checkpoint is required for the first working product version and explicit performance complaints; use the agent-controlled browser first and `npm run verify:perf` only as fallback. Performance fixes must preserve the selected scale. Diagnose whether lag comes from renderer technique, React update frequency, decoded media, shader/program setup, buffer uploads, layout work, stale async renders, or animation scheduling before reducing quality. Do not silently downsample, stretch a lower-resolution backing canvas, blur output, or clamp `canvas.renderScale` below the user's chosen value. Do not enable it for DOM/SVG/vector-native previews; use native vector rendering for those.

When `panels.timeline` is enabled, runtime appends a `Timeline` switch as the last control in `Setup`, after `Resolution scale` when present. The switch controls runtime presentation only: off shows compact Play-only transport, on shows the extended timeline with scrubber, duration, loop, and keyframe UI. It does not pause playback, change keyframes, alter export, write product `values`, or reset with `Reset controls`. If `persistence.include` contains `"panels"`, the extended/compact state can restore as a UI preference.

## Media Defaults

Use `media.defaultAssets` when the app starts with predefined files, source images, masks, symbol sets, or background images. Each item should set `sourceTarget` to the matching `fileDrop` control target. The runtime treats these as attached files: users see them in the uploader, can remove them to get an empty source/canvas state, and Reset restores them.

If removal, reorder, or transforms of predefined media should survive reload, add `"media"` to `persistence.include`; do not mirror the file list into product `values` and do not hard-code the file in `canvasContent`.

## Panels

- Use `panels: {}` for the neutral starter or for products that have no user-facing panels yet.
- Controls panel is the primary editing panel once the product has schema controls.
- Layers are optional. Enable only for multiple editable objects, media objects, groups, visibility, selection, reorder, or selected-layer controls.
- Do not use `selectedLayer.*` targets when layers are disabled.
- Timeline is optional only for autonomous decorative animation with no video export. Use playback, keyframes, or custom reference timeline from product transport behavior.
- Timeline compact/extended presentation is runtime panel UI state controlled by the auto-injected `Setup` switch, not a product control target.
- Do not add right-panel Play, Pause, Animate, or Restart controls for app-wide transport. Use the top timeline.

## Built-In Control Types

Use built-ins before custom controls. Unknown `type` values render nothing unless the app passes a matching `controlRenderers` entry.

| `type` | Renders | Key fields |
| --- | --- | --- |
| `actions` | Local action buttons for the current section or nearby entity, rendered below the label in a two-column grid | `actions`, `target`, `label` |
| `anchorGrid` | Anchor picker | `defaultValue`, `target` |
| `channelMixer` | RGB-only channel matrix mixer with R/G/B tabs and Red/Green/Blue source sliders | `defaultValue`, `target`, `label` |
| `checkbox` | Checkbox field | `defaultValue`, `target`, `label` |
| `collectionActions` | Add/remove buttons for repeatable product entities and their runtime-backed item controls | `defaultValue: []`, `itemControl`, `itemDefaultValue`, `itemLabel`, `minItems`, `recommendedMaxItems`, `hardMaxItems`, `target` |
| `code` | Multiline textarea | `defaultValue`, `target`, `label` |
| `color` | Hex color picker | `defaultValue: { hex }`, `target`, `label` |
| `colorOpacity` | Hex color picker plus opacity percent input | `defaultValue: { hex, opacity }`, `target`, `label` |
| `curves` | RGB or single curve editor | `defaultValue`, `target`, `variant: "single"`, `interpolation: "smooth" \| "monotone"` |
| `fileDrop` | Upload/drop input; `assetKind: "image"` owns image previews, rotate/flip actions, selection for multi-image transforms, and cover/crop canvas source behavior; `assetKind: "file"` owns sortable arbitrary file lists | `assetKind`, `accept`, `multiple`, `defaultValue`, `target` |
| `fontPicker` | Font preview select with popup, category search, weight, size, text case, text color/opacity, letter spacing, and line height; product text must consume `fontId`, `fontWeight`, `fontSize`, `letterSpacing`, `lineHeight`, `textCase`, `color`, and `opacity`; default text color is `#FFFFFF` at `100` opacity | `defaultValue: { fontId, fontWeight, fontSize, letterSpacing, lineHeight, textCase, color, opacity }`, `target` |
| `gradient` | Gradient editor | `defaultValue: { angle, gradientType, stops }`, `target` |
| `imagePicker` | Image choice grid | `items`, `defaultValue`, `target` |
| `palette` | Constrained design-token palette picker for family + shade | `defaultValue: { family, shade }`, `target` |
| `panelActions` | Sticky footer product actions | `actions`, `target`, `variant` |
| `rangeInput` | Two compact text values | `defaultValue: { start, end }`, `target` |
| `rangeSlider` | Two-thumb slider | `defaultValue`, `min`, `max`, `step`, `variant` |
| `segmented` | Segmented control | `options`, `defaultValue`, `variant` |
| `select` | Select dropdown | `options`, `defaultValue` |
| `slider` | Single-value slider | `defaultValue`, `min`, `max`, `step`, `unit`, `variant` |
| `switch` | Binary switch | `defaultValue`, `target`, `label` |
| `text` | Single-line input | `defaultValue`, `target`, `label`, `commitMode` |
| `vector` | X/Y vector pad and fields | `defaultValue: { x, y }`, `xLabel`, `yLabel`, `variant`, `coordinateMode` |

For `select`, standalone controls render stacked and full-width with the label above the dropdown. Do not use the old compact side-label row with label left and dropdown right. Use compact two-column inline layout only for related short select pairs that tune one workflow or entity, such as export `Format` and `Resolution`.

`text` defaults to `commitMode: "content"` and applies while typing for short real content such as button labels, canvas labels, names, titles, captions, tokens, compact prompts, and other one-line text. Use `commitMode: "setting"` for text inputs that edit settings such as font size, numeric-like style values, dimensions, ids, or configuration fields; setting text commits on blur or Enter. Canvas width and Canvas height always commit on blur or Enter. `code` / `CodeTextarea` is a content editor for long, multiline, or structured values, applies while typing, and is capped at 12 visible lines. Long content scrolls inside the textarea instead of making the controls panel taller. Do not use `code` for short single-line button/canvas text unless `description` explicitly proves the field is intended for long or structured input.

For `slider` and `rangeSlider`, `unit` is a real measurement suffix, not the entity being counted and not a generic multiplier. Use units such as `%`, `px`, `°`, `s`, `ms`, `fps`, `rows`, or `cols` only when they clarify the number. Do not use `unit: "x"`; scale, multiplier, intensity, opacity, strength, depth, and shader amount values display plain numbers unless a real measurement unit applies. Do not add repeated nouns such as `letters`, `shapes`, `words`, `symbols`, `items`, `particles`, or `layers` when the label or section already names that entity. If the value needs a noun, rename the label or section. Word or acronym units, when truly needed, render with a space (`5 cols`, `17 fps`); compact symbol/CSS units stay tight (`70%`, `24px`).

`slider` and `rangeSlider` are live controls. Dragging must update runtime state and product output while the drag is in progress, not only on pointer release, blur, Apply, or a final commit. Treat a non-live slider as a broken product mapping unless an extreme measured performance ceiling is documented; even then, keep immediate lightweight canvas feedback and refine the heavy output after coalescing/caching.

For `vector`, the default/spatial variant uses `coordinateMode: "screen"` by default: dragging left/up lowers `x` and `y`, so canvas objects move left/up without renderer-side Y inversion. Use it only for stable user-authored two-axis parameters. Do not expose Vector for current animation state, keyboard movement, pointer movement, physics state, timeline phase, velocity, target pose, current pose, or simulated position/direction just because the internal value has `x` and `y`. Use `coordinateMode: "cartesian"` only for intentional mathematical Y-up coordinates. Color variants keep their color-axis semantics by default. Vector pad value labels show compact rounded coordinates; raw floating-point tails must never appear in the controls panel. Double-clicking the pad resets both axes to the control default through the normal runtime value update, matching the section header reset; if no default is defined, the fallback is `0,0`. Holding Shift while dragging locks movement to the dominant axis and must not select text or page content.

Use `collectionActions` when the product owns a growable/shrinkable item list. `minItems` protects the smallest valid output, `recommendedMaxItems` is only a design recommendation, and `hardMaxItems` is valid only for a real product or technical limit. Adding/removing items must update the runtime array and the renderer/export must consume that same array. Do not pair a count slider with hidden fixed item controls when the user needs to add or remove actual entities. The collection label is on the left and remove/add buttons stay on the right. Homogeneous repeated items do not show visible per-item labels when the collection label already names the group. `itemControl.type` supports normal item built-ins such as `color`, `colorOpacity`, `text`, `select`, `segmented`, `slider`, `switch`, `checkbox`, `rangeInput`, and `fontPicker`; item controls still follow normal density rules, so plain colors use equal 50% columns when they fit. Use `fontPicker` as the item control when each repeated item is a text style or typography entity; do not split its font, weight, size, case, color/opacity, letter spacing, or line height into sibling collection fields.

Segmented controls are full-width compact choices. Do not place `segmented` in inline half-width rows beside Switch, Color, Select, or another control; use `select` when a finite choice must occupy a half-width column.

## Control Selection Inventory

Before writing schema controls, map product needs to built-ins by value model, not visual similarity.

For every user-visible product setting or action, write:

```txt
Product need:
Value model:
Candidate built-ins checked:
Best built-in:
Rejected alternatives:
Target:
Required acceptance:
```

If a built-in exact owner matches the value model, use that built-in. If several controls fit, choose the best fit and record why. If no built-in fits, use the custom escape hatch from `component-rules.md`.

For `curves`, choose the variant explicitly. Use `variant: "single"` for acceleration, bend, easing, response, depth, mask, opacity, threshold, or remap curves. Omit it only for RGB/color-correction or channel-specific curves that intentionally need RGB/R/G/B tabs.

## Video Reference Study

When a video, GIF, screen recording, contact sheet, or extracted-frame sequence is supplied as a reference, declare `appTransferMode.videoReferenceStudy` before implementation. This is independent of whether the app is a new Toolcraft app or a reference-runtime clone.

```ts
export const appTransferMode = {
  mode: "new-toolcraft-app",
  videoReferenceStudy: {
    acceptanceMapping: [
      {
        acceptanceId: "reference.video.motion",
        behavior: "Body motion preserves planted contact points before retargeting.",
        frameIds: ["f000", "f012", "f024"],
      },
    ],
    behaviorDecomposition:
      "The reference decomposes into moving body state, persistent anchors, delayed release, and retargeting behavior.",
    extractionEvidence:
      "Extracted frames with ffmpeg and reviewed a contact sheet before implementation.",
    referenceLocation: "/path/to/reference.mp4",
    storyboard: [
      {
        behaviorObservation: "Several endpoints remain planted while the body moves.",
        frameId: "f000",
        frameSource: "frames/frame_000.png",
        timeSeconds: 0,
        visualObservation: "The body is left of center with legs spread outward.",
      },
    ],
    transitionAnalysis: [
      {
        behaviorDelta:
          "Between f000 and f012, body position changes while endpoints stay near their previous canvas positions.",
        fromFrameId: "f000",
        id: "f000-f012",
        toFrameId: "f012",
      },
    ],
  },
} satisfies ToolcraftTransferMode;
```

The real study must include at least four storyboard frames, at least three frame-to-frame transition rows, behavior decomposition, and acceptance mapping to automated browser-backed tests. Do not implement from a single screenshot or static summary when the reference is temporal.

## Reference Transfer Mode

Reference clones must declare `referenceFeatureInventory` beside `behaviorCoverage`. The inventory is the source checklist for the port and is validated against acceptance rows.

```ts
export const appTransferMode = {
  behaviorCoverage: ["canvas-sizing", "control-mapping", "renderer-state"],
  mode: "reference-runtime-clone",
  referenceFeatureInventory: [
    {
      acceptanceId: "reference.rendererState",
      behaviorEvidence:
        "Observed the reference renderer keep particle state across multiple frames.",
      featureName: "Renderer state",
      id: "renderer-state",
      referenceBehavior:
        "The reference renderer keeps mutable particle state across frames.",
      sourceEvidence: "Inspected reference/src/renderer.ts frame loop.",
      status: "ported",
      toolcraftMapping:
        "The Toolcraft renderer keeps equivalent state and invalidation keys.",
    },
  ],
  referenceName: "Original app",
  referenceStudy: {
    behaviorEvidence:
      "Ran the original app in a local browser and verified controls, renderer state, export, and media behavior.",
    referenceLocation: "/path/to/original-app",
    reproductionSteps:
      "Installed dependencies, started the reference app, opened it in the browser, and compared behavior against the Toolcraft port.",
    sourceEvidence:
      "Inspected routes, renderer, control state, timeline/export handlers, and media lifecycle files.",
    status: "ran-original",
  },
  referenceTimeline: { behaviorCoverage: [], mode: "none" },
  sourceOfTruth: "reference-runtime",
} satisfies ToolcraftTransferMode;
```

If the original cannot run as-is but behavior can be reconstructed, use `status: "restored-local"` and describe the restoration steps. Use `status: "source-inspection-only"` only with `sourceOnlyReason` explaining the concrete blocker that made running or restoring unavailable.

Use `status: "ported"` when the behavior is carried over directly and `status: "toolcraft-native"` when Toolcraft owns the same behavior, such as canvas sizing or export shell. Use `status: "intentionally-changed"` only with `userApprovedChangeReason` that cites explicit user approval or redesign/change-request evidence.

## Animation Intent

Before adding animation controls, decide the animation owner:

- `timeline-playback`: product time controlled by the top timeline.
- `timeline-keyframes`: property animation controlled by keyframe diamonds and rows.
- `autonomous`: decorative/self-running output with no user-facing transport and no video export.

In keyframes mode, renderer code reads evaluated values from the runtime keyframe evaluator. Do not parse timeline labels and do not use raw `state.values` for targets with keyframes.

If the product output is animated, use the top Toolcraft timeline. Use `panels.timeline: { mode: "playback", defaultDurationSeconds }` for playback animation and set `defaultDurationSeconds` to the product loop duration when it is known. When `panels.timeline` is enabled for a new Toolcraft app, `appTransferMode.animationIntent` must match it: `mode: "timeline-playback"` for playback, or `mode: "timeline-keyframes"` for keyframes. `appTransferMode.animationIntent` must declare `loopDuration: { source, seconds, evidence }` for playback/keyframe animation; valid sources are `reference`, `user-request`, and `product-derived`, never runtime/template fallback 8s. Reference clones that choose `referenceTimeline.mode: "toolcraft-playback"` or `"toolcraft-keyframes"` declare the same shape on `appTransferMode.referenceTimeline.loopDuration`. `defaultDurationSeconds` must equal the declared `loopDuration.seconds`. Any app with `Export Video` must enable the top Toolcraft timeline and use runtime timeline time for preview/export duration and seamless forward-loop behavior. Product loops must advance in one direction and stitch first/last frames at any timeline duration; mirror, yoyo, ping-pong, or reverse loops require explicit user request. Playback renderers should use `getToolcraftTimelineLoopTime` or `getToolcraftTimelineLoopProgress` so `state.timeline.durationSeconds` remains the active loop period after the user edits duration. If no timeline is used while animation controls remain visible, `appTransferMode.animationIntent` must declare `mode: "autonomous"`, include a concrete reason, include behavior coverage for no transport, no play/pause, no scrub, no duration control, no loop control, and no export-at-time, and prove there is no product animation and no video export.

## Control Section Inventory

Before editing `panels.controls.sections`, define and export `starterControlSectionInventory` beside `appAcceptance` in `src/app/app-acceptance.ts`. This is the machine-checkable version of the section plan.

- section title;
- product entity or workflow stage;
- included schema targets;
- reason these controls belong together or reason for a real workflow split.

```ts
export const starterControlSectionInventory = [
  {
    entity: "Text block",
    groupingReason:
      "These controls edit the text content, typography, and visible text fill together.",
    targets: ["text.content", "text.font"],
    title: "Text",
  },
  {
    entity: "Object shape",
    groupingReason: "Structure controls tune the physical footprint of the object.",
    splitReason:
      "Structure and density are separate workflow stages in this editor.",
    targets: ["object.shape.size"],
    title: "Shape Structure",
    workflowStage: "structure",
  },
] as const;
```

Group controls by product meaning, not by component type. Do not create sections named `Controls`, `Settings`, `Options`, `Sliders`, `Inputs`, `Buttons`, `Color`, or `Colors`.

The inventory must match the rendered schema: every product control target in every product section appears exactly once, and every inventory target renders in the section named by `title`. Runtime `Setup` controls, sticky footer `Export` actions, `settingsTransfer`, and runtime canvas sizing controls do not need inventory entries. If one target entity is split across sections, every split section must declare `workflowStage` and a concrete `splitReason`; otherwise the validator treats the split as accidental section drift.

Every app-authored controls-panel body section must have a short meaningful visible title. Runtime-created `Setup` renders as the first visible headerless controls block with no title, reset action, collapse button, or collapsed state; sticky footer action sections use the technical title `Export` but render without a visible heading.

Every visible app-authored section title renders through the standard 36px collapsible header row with vertically centered text and the runtime collapse icon. Do not hand-build section headers in generated apps.

Section expand/collapse uses the standard runtime height/opacity animation. Do not replace it with instant custom section visibility.

Section collapsed/expanded state persists as a per-app runtime UI preference. It is not undo/redo state, not settings import/export state, and `Reset controls` must not clear it. Runtime `Setup` is not collapsible; sticky footer `Export` sections are not collapsible.

Ordinary section headers expose the runtime section reset action before the collapse button. It dispatches `controls.resetTargets` and restores only that section's control targets to their schema `defaultValue`.

Runtime `Setup` and ordinary controls-panel body sections use 8px top spacing and 24px bottom spacing for their control content. Sticky footer action sections keep their dedicated spacing.

Large built-in compound controls inside mixed sections render content-width internal dividers with 18px between each rendered divider and the control content. If a compound control is the first item in that section, render only its bottom internal divider and remove the top internal padding. If it is the last item in that section, render only its top internal divider and remove the bottom internal padding. If a section contains exactly one control, whether simple or compound, only the parent section dividers render. Single `curves` are not compound for dividers; RGB `curves` are compound.

Controls for the same product entity stay in the same section. For example, `squares.right.connections`, `squares.right.hoverRadius`, and `squares.right.color` belong in `Square 1 (Right)` with `Color` as the field label. A standalone color section is only valid when the color is the whole product entity, such as `Background`, `Accent`, `Connector`, or `Brand`.

Keep sections discrete. A section usually has two to seven product controls. If a section grows past seven controls, split it by the next product sub-entity or workflow stage instead of keeping a broad bucket. Broad titles such as `Flow`, `Icon`, `Shapes`, `Scene`, `Text`, `Typography`, or `Motion` are valid only for small cohesive groups; larger groups need specific titles such as `Flow Motion`, `Flow Geometry`, `Letter Burst`, `Shape Colors`, `Logo Glow`, `Logo Plate`, or `Text Block`. Section titles must be unique in the same panel.

Control labels are judged with their nearest visible context. Short property labels such as `Speed`, `Color`, `Size`, or `Opacity` are allowed when the section or group clearly names the edited product entity. If the section is generic, mixed, missing, or otherwise weak context, include the affected entity or role in the label, such as `Pattern color`, `Background opacity`, `Wave speed`, or `Stroke width`. Acceptance suggests a semantic replacement label; fix the schema label instead of relying on runtime fallback rewriting.

If a target prefix has to be split across sections, the spec must name the workflow reason. Otherwise the acceptance validator treats the split as a sectioning error.

Switch and checkbox labels name the setting context only. Do not prefix them with `Enable` or `Disable`; use `CRT`, `Glow`, `Loop`, or `Guides` instead. If the nearest section title already names the context, do not duplicate it as the visible toggle label. Use a short contextual label such as `Include` or, only for icon-only visual toggles, `label: false` with the product meaning in `target` and `description`.

Inline two-column groups are preferred when controls tune one close product meaning and labels/values fit. Short numeric text pairs can be inline. Related short `select` pairs can be inline, especially workflow pairs such as `Format` + `Resolution`, `Codec` + `Profile`, or `Width unit` + `Height unit`. Use stacked one-control rows only as a fit fallback when a label, selected value, or option text would clip, truncate, or lose padding; record that fallback reason in the spec or worklog. A short numeric/text field may also pair with one related plain `color` field when both configure the same entity, such as `Mask size` and `Color` inside `Mask`. `colorOpacity` never renders in inline two-column groups; if either color control has opacity, keep the controls stacked. Color labels are semantic, not automatic: decide once for the whole color group, omit per-item labels such as `Color 1` for palette variation banks like `Accent Shades` or `Bead Colors`, and do not mix labeled and unlabeled items inside that bank. Sibling controls like `Spread` or `Randomness` do not force item labels; keep visible labels only when colors edit distinct roles such as `Fill`, `Stroke`, `Background`, `Connector`, or `Object`. Related plain color banks render two per row, and an odd trailing plain color remains half-width instead of stretching to a full row. Mixed inline rows usually require visible labels on every field, except toggle-plus-parameter rows, the required Background row, and palette variation color banks whose group/section label already names the bank. All 50/50 inline rows use the same horizontal column gap as paired `select` controls; do not create a wider or narrower gap for toggle-plus-parameter rows. Two adjacent `switch` or `checkbox` controls for the same product entity must share one inline row when both visible labels fit without truncation; the runtime auto-pairs safe adjacent toggles by target entity, and schemas should stack them only when either label is too long. A single `switch` or `checkbox` may share an inline row with one related parameter control when the toggle label fits and both controls edit the same entity; the non-toggle parameter uses `label: false`, and if that label is needed, stack the controls instead. Toggle plus parameter rows are equal-width two-column rows: each control occupies one half, never intrinsic toggle width plus remaining space. The required Background row uses `Include` plus unlabeled background color. Schema `slider` and `rangeSlider` controls always stay stacked at full width; the only built-in exception is the paired letter-spacing and line-height footer sliders inside `fontPicker`. Do not place sibling controls for case, color, opacity, size, weight, letter spacing, or line height when the same text entity already uses `fontPicker`.

`rangeSlider` is always a full-width two-thumb control. Do not include it in `layoutGroups`. Its `defaultValue` must start with different lower and upper values, such as `[20, 80]`, so the two handles do not collapse into one apparent slider. Manual range labels accept built-in separators such as slash, hyphen, spaces, and dashes.

## Control Order

Order controls by decision flow inside each section:

- `input`: upload, source, and canvas-size controls;
- `mode`: mode, type, filter, blend, style, and preset selectors;
- `primary`, `spatial`, `color`: core product parameters;
- `strength`: intensity, opacity, scale, depth;
- `detail`: noise, texture, blur, density, radius, quality;
- `advanced`: secondary tuning;
- `action`: footer actions.

A selector that changes how later controls are interpreted must use `orderRole: "mode"` and sit above dependent parameters.

Use `visibleWhen` for mode-, type-, source-, include-, variant-, or count-exclusive controls and sections. Example: `Partner` is visible when `coBrand.identityMode` is `text`; `Partner logo` is visible when it is `logo`. Count-controlled banks use numeric conditions: `Shade 4` is visible when `shapes.shadeCount` is `greaterThanOrEqual: 4`. When every control in a section is hidden by `visibleWhen`, the whole section is hidden automatically. If a switch/select/segmented/imagePicker/checkbox chooses a branch for the same product entity, controls outside the current branch use `visibleWhen`, not `disabledWhen`.

If a selector says “use the first N”, “number of colors”, “number of stops”, “active slots”, or similar, dependent sibling controls must be hidden with `visibleWhen` when they are outside the current count. Do not leave all possible controls visible while making the renderer ignore the inactive ones.

App schema tests must assert visible control order with `getToolcraftControlOrderTargets(appSchema)` or an equivalent exact target-order check.

## Persistence

State persistence is a product policy, not a hidden side effect.

Use `persistence: { storage: "localStorage", key, version, include }` when user-edited app settings should survive reload. Typical product editors persist `values`, `canvas`, and `panels`. If localStorage persistence is enabled and any runtime panel is visible, `include` must contain `"panels"` so dragged panel positions survive reload in that specific app. Add `timeline` when playback position, duration, loop, expansion, or keyframes should survive reload. Add `layers` only when the app has a real layer model. Add `media` only when runtime media state must survive reload, such as predefined attached files that users can delete, reorder, or transform.

Do not write media state directly to storage and do not use product values to mirror the attached file list. Use `media.defaultAssets` for predefined source files/background images; they render as ordinary `fileDrop` attachments, can be removed to produce an empty source/canvas state, and Reset restores them. Theme preference is runtime-owned separately. Do not write runtime state to `localStorage` directly from app code.

If `storage` is `"localStorage"`, add a runtime acceptance row with `persistenceCoverage: "reload"` and a browser test that changes a user-facing setting, reloads the page, and verifies the restored value or product output. Settings import/export is preset transfer, not proof that persistence works.

## Settings Transfer

Generated apps keep a controls panel so runtime `Setup` is visible from the first run. Product controls are added after that mandatory runtime section. Use `settingsTransfer` only to customize the exported JSON identity or file name.

```ts
settingsTransfer: "auto"
```

Allowed values:

- `"auto"`: default. Runtime still shows the mandatory first Setup section.
- `true`: keep the mandatory section and mark settings transfer explicitly enabled.
- `false`: keep the mandatory section; this value is retained as metadata only and does not hide `Export Settings` / `Import Settings`.
- `{ enabled, appId, fileName }`: customize the exported JSON identity and file name.

Runtime inserts a visible headerless `Setup` controls block as the first controls-panel block. It exports and imports control values, `canvas.size`, and timeline state, ignores unknown targets on import, and pauses playback after importing.

Do not add settings transfer buttons manually and do not use complexity thresholds to decide whether they appear.

When the canvas uses `editable-output` sizing, `Setup` contains `Export Settings`, `Import Settings`, `Aspect ratio`, `Canvas width`, `Canvas height`, optional `Resolution scale`, and optional `Timeline` in that order. Do not split these into separate sections or recreate them manually. Product sections must not declare `runtime.settingsTransfer`, `canvas.aspectRatio`, `canvas.size.width`, `canvas.size.height`, `canvas.renderScale`, or `panels.timeline.extended`; runtime Setup owns those targets and always renders its own controls.

A settings-transfer section with only `Export Settings` and `Import Settings` means the canvas is not `editable-output`. For product-output apps, treat that as a schema error to fix, not as a layout variant.

Do not hand-write `settings-transfer.ts`, hidden file inputs, route handlers, or `panelActions` for settings import/export. Sticky footer `panelActions` remain product delivery only.
