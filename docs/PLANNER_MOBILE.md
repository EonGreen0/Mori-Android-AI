# Mobile Planner and AI Layout

## Zoom and pan

- Pinch with two fingers to zoom the planner canvas around the gesture center.
- Drag blank canvas space with one finger to pan.
- Use the `-`, percentage and `+` controls in the mobile toolbar.
- Tap the percentage to return to 100%.
- Use Fit All to frame the complete plan.
- When a second finger touches while dragging a node, node movement is cancelled and the gesture becomes a pinch.

The gesture handlers run for editable local plans as well as read-only plans.

## AI Plan

The AI Plan button analyzes image nodes already present in the current planner board:

1. Existing image analysis is reused from the AI cache.
2. Images without analysis are sent individually to the configured multimodal model.
3. Images are grouped by the fixed pose taxonomy.
4. The user reviews group counts and confirms.
5. The app creates labeled group boxes and positions the images in a responsive 3-column layout.
6. Previously generated AI group boxes are replaced; user-created nodes and notes are preserved.

AI planning never deletes image files or user-created notes. The resulting board remains editable and uses the same save/render path as manual planner changes.
