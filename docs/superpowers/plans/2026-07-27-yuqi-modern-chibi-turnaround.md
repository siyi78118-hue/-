# Yuqi Modern Chibi Turnarounds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generate three distinct, internally consistent modern Q-style character turnaround sheets for Yuqi so the user can choose a canonical visual design.

**Architecture:** Treat the supplied image as a style and layout reference only. Generate each wardrobe direction as an independent raster asset while locking Yuqi's face, hair, age cues, body proportions, signature hair clip, three-view order, and neutral presentation across all three outputs; then visually inspect every output against the design specification.

**Tech Stack:** Built-in image generation tool, local image inspection, PNG raster assets.

## Global Constraints

- Each output contains exactly one Yuqi shown three times: front, strict 90-degree side, and back.
- The three figures are equal scale, full body, baseline aligned, and separated on a clean warm off-white background.
- Yuqi is a 24-year-old modern editor with black-tea medium-long straight hair, side-parted wispy bangs, gray-violet eyes, and a slim silver paperclip hair clip on the left.
- Q-style proportions are approximately 3 to 3.5 heads tall and cute without appearing infantile.
- No text, labels, watermark, frame, scene, ancient costume, school uniform, lolita fashion, idol costume, or visible brand.
- The reference image controls only the soft hand-drawn watercolor finish and three-view sheet layout.
- Final assets are saved under `artifacts/yuqi-character-design/`.

---

### Task 1: Generate the Urban Editor Turnaround

**Files:**
- Create: `artifacts/yuqi-character-design/yuqi-a-urban-editor.png`

**Interfaces:**
- Consumes: `docs/superpowers/specs/2026-07-27-yuqi-modern-chibi-turnaround-design.md`
- Produces: A complete three-view sheet for wardrobe option A.

- [x] **Step 1: Generate the image**

Use the built-in image generation tool with the supplied reference image identified as style/layout reference only. Request the fixed Yuqi appearance and the following outfit: ink-navy relaxed cropped blazer, ivory fine-knit top, gray-blue high-waisted midi A-line skirt, dark loafers with understated socks, structured dark-gray work tote with a tiny ticket-shaped charm.

- [x] **Step 2: Inspect the output**

Open the generated image and verify exactly three full-body views, correct front/side/back order, consistent hair and garment construction, modern clothing, adult age cues, clean background, and absence of text or watermark.

- [x] **Step 3: Save the accepted image**

Copy the accepted PNG to `artifacts/yuqi-character-design/yuqi-a-urban-editor.png` without overwriting unrelated assets.

### Task 2: Generate the Rainy-Night Literary Turnaround

**Files:**
- Create: `artifacts/yuqi-character-design/yuqi-b-rainy-night.png`

**Interfaces:**
- Consumes: The same fixed Yuqi appearance and turnaround layout defined in Task 1.
- Produces: A complete three-view sheet for wardrobe option B.

- [x] **Step 1: Generate the image**

Use a separate built-in image generation call. Request a mist-blue short trench coat, charcoal thin turtleneck, charcoal high-waisted straight trousers, black ankle boots, understated small crossbody bag, tiny silver raindrop stud, and the fixed silver paperclip hair clip.

- [x] **Step 2: Inspect the output**

Verify that the result remains the same Yuqi as option A, contains exactly three aligned full-body views, preserves garment structure between views, and communicates quiet rainy-city intelligence without adding umbrellas, scenery, text, or ancient elements.

- [x] **Step 3: Save the accepted image**

Copy the accepted PNG to `artifacts/yuqi-character-design/yuqi-b-rainy-night.png`.

### Task 3: Generate the Off-Duty Yuqi Turnaround

**Files:**
- Create: `artifacts/yuqi-character-design/yuqi-c-off-duty.png`

**Interfaces:**
- Consumes: The same fixed Yuqi appearance and turnaround layout defined in Task 1.
- Produces: A complete three-view sheet for wardrobe option C.

- [x] **Step 1: Generate the image**

Use a separate built-in image generation call. Request a charcoal relaxed cropped jacket, muted teal hoodie, dark-gray loose cargo trousers, warm-gray modern sneakers, lightweight over-ear headphones resting around the neck, a small ticket stub peeking from a pocket, and the fixed silver paperclip hair clip.

- [x] **Step 2: Inspect the output**

Verify exactly three aligned full-body views, consistent clothing and hair, an adult but lively expression, no aggressive biker styling, no rebellious teen styling, no text, and no extra objects.

- [x] **Step 3: Save the accepted image**

Copy the accepted PNG to `artifacts/yuqi-character-design/yuqi-c-off-duty.png`.

### Task 4: Cross-Variant Visual QA

**Files:**
- Verify: `artifacts/yuqi-character-design/yuqi-a-urban-editor.png`
- Verify: `artifacts/yuqi-character-design/yuqi-b-rainy-night.png`
- Verify: `artifacts/yuqi-character-design/yuqi-c-off-duty.png`

**Interfaces:**
- Consumes: All three generated PNG assets.
- Produces: Three presentation-ready alternatives that visibly depict one consistent character.

- [x] **Step 1: Compare identity consistency**

Inspect the three outputs together. Confirm the same hair color and length, bang division, gray-violet eyes, facial proportions, age impression, paperclip hair clip, Q-style scale, and soft watercolor line treatment.

- [x] **Step 2: Compare option differentiation**

Confirm option A reads as a professional editor, option B as quiet rainy-night literary city wear, and option C as lively off-duty casual wear. Reject any pair whose silhouettes are too similar to make a meaningful choice.

- [x] **Step 3: Deliver all accepted assets**

Render all three PNGs inline with labels in the response and provide clickable absolute file links so the user can choose A, B, or C.
