# Yuqi WeChat Avatar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 生成一张符合虞栖聊天描述、可直接更换为微信头像的方形雨后街景图片。

**Architecture:** 使用内置图像生成工具生成单张真实摄影风方图，再进行内容与裁切安全检查。合格成品保存到项目 `artifacts/`，不修改应用代码或现有头像文件。

**Tech Stack:** Built-in image generation、Codex 本地图片检查工具、PNG

## Global Constraints

- 输出为 1:1 方形头像，适配微信小尺寸显示与圆形裁切。
- 蓝灰色雨后空街为主体，湿路面有灯光倒影，右侧小店为唯一暖黄色光源。
- 无人物、文字、水印、车辆、雨伞、装饰性花朵和夸张霓虹。
- 保持真实手机随拍质感，不做花哨网红风或强烈赛博朋克风。

---

### Task 1: Generate and validate the avatar

**Files:**
- Create: `artifacts/yuqi-wechat-avatar-rainy-street.png`
- Reference: `docs/superpowers/specs/2026-07-20-yuqi-wechat-avatar-design.md`

**Interfaces:**
- Consumes: 已确认的头像设计规格。
- Produces: 一张可直接用作微信头像的 PNG 方图。

- [ ] **Step 1: Generate the square image**

Use the built-in image generation tool with this prompt:

```text
Use case: photorealistic-natural
Asset type: square WeChat profile avatar
Primary request: A quiet, realistic mobile-phone photograph of an empty street just after rain, matching Yuqi's own chosen avatar description.
Scene/backdrop: blue-gray overcast evening sky; wet asphalt street with subtle reflected lights; one small shop on the right side glowing with warm yellow light.
Composition/framing: square 1:1 composition, eye-level street view, simple geometry, strong readability at thumbnail size, important elements kept within a circular-crop safe area.
Lighting/mood: restrained, quiet, slightly distant, natural post-rain atmosphere; cool blue-gray dominates and the shop is the only warm visual anchor.
Style/medium: authentic candid smartphone photography, natural lens perspective, gentle realistic grain, not staged or over-processed.
Constraints: no people, no readable text, no watermark, no vehicles, no umbrellas, no flowers, no prominent signage.
Avoid: cyberpunk neon, dramatic cinematic grading, fantasy atmosphere, illustration, painterly style, excessive fog, overly glossy reflections.
```

Expected: one square photorealistic image with a clear cool/warm relationship.

- [ ] **Step 2: Inspect visual compliance**

Open the generated image and verify all of the following:

```text
1. The street is empty and visibly wet after rain.
2. Blue-gray remains the dominant palette.
3. A warm yellow-lit small shop sits on the right.
4. No people, text, watermark, vehicles, umbrellas, flowers, or neon clutter appear.
5. The scene remains legible when mentally reduced to a small avatar and circularly cropped.
```

Expected: all five checks pass. If exactly one check fails, regenerate once with only that issue strengthened in the prompt.

- [ ] **Step 3: Save the approved image**

Copy the approved built-in output to:

```text
artifacts/yuqi-wechat-avatar-rainy-street.png
```

Expected: the PNG exists inside the project and the original generated output remains unmodified.

- [ ] **Step 4: Final verification**

Open `artifacts/yuqi-wechat-avatar-rainy-street.png` and confirm it renders correctly as a square image with no corruption.

- [ ] **Step 5: Commit the avatar**

```powershell
git add -- "artifacts/yuqi-wechat-avatar-rainy-street.png"
git commit -m "art: add yuqi rainy street avatar"
```
