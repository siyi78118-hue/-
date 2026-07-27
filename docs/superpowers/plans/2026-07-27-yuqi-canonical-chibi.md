# Yuqi Canonical Chibi Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generate one canonical modern Q-style full-body turnaround of Yuqi using Yuqi's own visual description as the authoritative prompt.

**Architecture:** Use the original supplied image only for soft Q-style linework and front/side/back layout. Generate a new character from the canonical specification, inspect the result for adult age cues, natural eye size, non-sweet expression, exact simple clothing, and turnaround consistency, then save it as a new project asset without replacing earlier explorations.

**Tech Stack:** Built-in image generation tool, local image inspection, PNG raster asset.

## Global Constraints

- Yuqi is a 24-year-old young woman with black straight hair below the shoulders, natural loose ends, and hair worn down.
- Her face is delicate but not doll-like; her eyes are naturally sized, intelligent and alert.
- Her expression carries slight defiance and a barely visible smile; she is not a sweet obedient heroine.
- Clothing is a white or light-gray thin knit top, deep-navy short jacket, black straight trousers, and simple comfortable shoes.
- Palette is low-saturation black, white, gray, and deep navy.
- The outfit has editorial bookishness without business-suit styling.
- No exaggerated eyes, heavy makeup, long trench coat, mature styling, visible brand, text, or watermark.
- The output is a full-body Q-style turnaround with front, strict side, and back views on a clean light background.
- Final asset path is `artifacts/yuqi-character-design/yuqi-canonical-by-yuqi.png`.

---

### Task 1: Generate and Validate the Canonical Turnaround

**Files:**
- Create: `artifacts/yuqi-character-design/yuqi-canonical-by-yuqi.png`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-27-yuqi-canonical-chibi-design.md`
- Produces: The canonical visual reference for future Yuqi emoji and character assets.

- [x] **Step 1: Generate one turnaround sheet**

Use the built-in image generation tool with the original user image labelled as a style/layout reference only. Normalize Yuqi's exact prompt into a production prompt without introducing a hair clip, bag, skirt, long coat, office suit, large eyes, heavy makeup, or new accessory.

- [x] **Step 2: Inspect identity and expression**

Verify that Yuqi reads as approximately 24, has naturally sized eyes, clean facial features, an intelligent alert gaze, and a faintly defiant half-smile rather than a sweet or cute performance.

- [x] **Step 3: Inspect outfit and turnaround**

Verify exactly three aligned full-body views in front/side/back order. Confirm the same below-shoulder black hair, thin knit top, deep-navy short jacket, black straight trousers, and simple shoes in all three views.

- [x] **Step 4: Save the accepted output**

Copy the generated PNG to `artifacts/yuqi-character-design/yuqi-canonical-by-yuqi.png`, preserving the earlier A, B, and C exploration images.

- [x] **Step 5: Deliver the result**

Render the final PNG inline and provide its clickable absolute project path. State that the built-in image generation path was used and summarize the canonical prompt constraints.
