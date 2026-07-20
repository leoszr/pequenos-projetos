# Finance Renderer Spec

## Renderer Technique Decision Matrix

- sourceRepresentation: procedural-data.
- productRepresentation: mixed text and vector-output.
- previewRenderer: DOM plus SVG.
- exportRenderer: Canvas 2D using the PNG export/copy helper.
- rendererWorkload: vector-output.
- rendererStrategy: dom.
- whyNotAlternativeStrategies: SVG-only cannot express the full dashboard table/card layout as cleanly; Canvas preview would rasterize text-output and reduce product-quality; WebGL/WebGPU are alternatives for pixel-output workloads but unnecessary here.
- fidelityRisks: exportRenderer is a canvas summary rather than DOM screenshot.
- performanceRisks: 360-month path rebuild and 4K export.

## Renderer Layer Inventory

- backgroundLayer: background DOM layer.
- productForegroundLayer: product-foreground DOM text/cards/table.
- chartLayer: product-foreground SVG geometry.
- exportComposite: export-composite Canvas 2D pass.

## Render Pipeline Inventory

rendererPipeline passes: calculate-series preprocess pass with cacheKey finance-config; svg-paths vector-build pass; dom-composite preview pass; png-export export pass. Interaction invalidation covers control-drag, control-change, viewport-zoom, viewport-drag, export, and avoids recomputing upstream passes during viewport interactions.
