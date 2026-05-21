# Design System Specification

## 1. Overview & Creative North Star
This design system is built to transform a standard medical utility into a high-end editorial experience. We are moving away from the "cluttered clinic" aesthetic toward a philosophy we call **"The Vital Pulse."**

The objective is to balance the clinical urgency of blood donation with an atmosphere of sophisticated calm. By utilizing intentional asymmetry, expansive whitespace, and a high-contrast typographic scale, we create a UI that feels authoritative yet breathable. In the context of Cameroon’s mobile-first, low-data environment, we achieve "premium" not through heavy assets, but through the precise orchestration of space, color, and typography.

## 2. Colors & Tonal Architecture
The palette is rooted in a professional medical red, supported by a sophisticated hierarchy of neutral tones that provide depth without visual noise.

### The Palette
*   **Primary (#af101a):** The "Pulse." Use this for critical actions and brand presence.
*   **Primary Container (#d32f2f):** Used for urgent states and high-visibility hero areas.
*   **Tertiary (#005f7b):** A calming slate-blue to balance the heat of the red, ideal for informational trust signals.
*   **Surface Hierarchy:** 
    *   `surface`: #f9f9f9 (Main background)
    *   `surface-container-low`: #f3f3f3 (Sectioning)
    *   `surface-container-highest`: #e2e2e2 (De-emphasized utility)

### Structural Rules
*   **The "No-Line" Rule:** Explicitly prohibit the use of 1px solid borders for sectioning content. To separate a card from the background, use a background shift (e.g., a `surface-container-lowest` card placed on a `surface-container-low` background).
*   **Signature Textures:** For primary CTAs, do not use flat colors. Apply a subtle linear gradient from `primary` (#af101a) to `primary_container` (#d32f2f) at a 135-degree angle to add "soul" and dimension.
*   **The Glass & Gradient Rule:** For mobile overlays and floating headers, use Glassmorphism. Apply `surface` at 80% opacity with a 12px backdrop blur. This ensures the UI feels lightweight and integrated into the user’s journey.

## 3. Typography
We use a dual-font strategy to create an editorial feel that remains highly legible on low-resolution screens.

*   **Display & Headlines (Manrope):** A modern geometric sans-serif that commands attention. Use `display-lg` (3.5rem) for hero statements and `headline-md` (1.75rem) for section titles. The generous x-height of Manrope conveys stability and trust.
*   **Body & Labels (Inter):** Chosen for its exceptional readability in technical contexts. Use `body-md` (0.875rem) for all functional text and data points.
*   **Intentional Contrast:** Pair a `display-sm` headline with a `label-md` in all-caps (0.05em letter spacing) to create a sophisticated, "magazine-style" hierarchy that guides the eye instantly to key information.

## 4. Elevation & Depth
In this design system, depth is a functional tool, not a decoration. We use **Tonal Layering** to define the interface's architecture.

*   **The Layering Principle:** Treat the screen as a series of stacked sheets.
    *   Level 0: `surface` (The base)
    *   Level 1: `surface-container-low` (Content groupings)
    *   Level 2: `surface-container-lowest` (Interactive cards/elements)
*   **Ambient Shadows:** Avoid standard black shadows. When an element must float (e.g., a FAB or a critical alert), use a shadow with a 24px blur, 4% opacity, using the `on-surface` color (#1a1c1c) to mimic natural light.
*   **The "Ghost Border" Fallback:** If a container requires a boundary for accessibility, use the `outline-variant` token at 15% opacity. Never use 100% opaque borders.

## 5. Components

### Buttons
*   **Primary:** Rounded `md` (0.375rem). Uses the signature Primary-to-Container gradient. Label is `title-sm` in `on-primary` (#ffffff).
*   **Secondary:** Ghost style. No background, only a `primary` text label with a `surface-container-high` background on hover.
*   **Tertiary:** `tertiary` (#005f7b) background for secondary information like "View History" or "Find Clinic."

### Cards & Lists
*   **The Divider Rule:** Forbid the use of horizontal lines to separate list items. Use 16px of vertical whitespace or a subtle background shift between items.
*   **Editorial Cards:** Use `surface-container-lowest` (#ffffff) with a `lg` (0.5rem) corner radius. Use asymmetric padding (e.g., 24px top/bottom, 20px sides) to create a custom, high-end feel.

### Input Fields
*   **Style:** Minimalist. No background fill. Use a bottom-only `outline-variant` line that transforms into a 2px `primary` line on focus.
*   **Labels:** Floating labels using `label-md` to maximize screen real estate on mobile devices.

### Special App Components
*   **The Urgency Badge:** A chip using `error_container` background with `on_error_container` text. Use for low-stock blood types (e.g., "O- Needed Urgently").
*   **The Progress Pulse:** A custom circular loader using `primary` and `primary_fixed_dim` to visualize donation progress or impact metrics.

## 6. Do's and Don'ts

### Do
*   **Do** use extreme whitespace (32px+) between major sections to let the design "breathe."
*   **Do** use `manrope` for numbers (blood counts, dates) to give them an authoritative, high-end look.
*   **Do** ensure all interactive elements have a minimum tap target of 48x48dp for mobile accessibility.

### Don't
*   **Don't** use generic icons. Use thin-stroke (1.5pt) custom iconography that matches the weight of the `Inter` typeface.
*   **Don't** use heavy photography. Instead, use SVG-based abstract shapes in `secondary_container` colors to add visual interest without increasing load times.
*   **Don't** use pure black (#000000). Always use `on_surface` (#1a1c1c) for text to maintain a premium, softer contrast.