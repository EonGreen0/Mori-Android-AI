import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/js/modules/planner.js", import.meta.url), "utf8");
const handlers = new Map();
const viewport = { addEventListener: (name, callback) => handlers.set(name, callback), focus() {},
  getBoundingClientRect: () => ({ left: 0, top: 0 }), classList: { add() {}, remove() {} } };
const context = { plannerBound: false, plannerElements: () => ({ viewport, marquee: {} }),
  window: { addEventListener() {} }, board: { readOnly: true, view: { panX: 0, panY: 0, zoom: 1 } },
  isPlannerMode: () => true, androidLimitedWriteEnabled: true, MIN_PLANNER_ZOOM: 0.1, MAX_PLANNER_ZOOM: 5,
  androidTouchManipulation: null, androidTouchWasMultitouch: false,
  selectedNodeIds: new Set(["image"]), selectedEdgeId: "edge", connectingEdge: {},
  updates: 0, updateSelectionUI: () => context.updates++, renderEdges() {}, saveBoard() {}, applyPlannerTransform() {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf("function bindPlannerInteractions()"), source.indexOf("\nfunction assertActivePlannerSyncTarget(")) + "\nbindPlannerInteractions();", context);
const point = (clientX, clientY) => ({ clientX, clientY });
const target = (node = false) => ({ closest: (selector) => node && selector.includes(".planner-node") ? {} : null });
const fire = (name, touches, node = false) => handlers.get(name)({ touches, target: target(node), preventDefault() {} });
const select = () => { context.selectedNodeIds = new Set(["image"]); context.selectedEdgeId = "edge"; };

fire("touchstart", [point(40, 40)]); fire("touchend", []);
assert.equal(context.selectedNodeIds.size, 0); assert.equal(context.selectedEdgeId, null); assert.equal(context.updates, 1);
select(); fire("touchstart", [point(40, 40)]); fire("touchmove", [point(43, 42)]); fire("touchend", []);
assert.equal(context.selectedNodeIds.size, 0, "minor finger jitter remains a tap");
select(); fire("touchstart", [point(40, 40)]); fire("touchmove", [point(70, 40)]); fire("touchmove", [point(40, 40)]); fire("touchend", []);
assert.equal(context.selectedNodeIds.size, 1, "dragging back to the origin must not become a tap");
select(); fire("touchstart", [point(40, 40)]); fire("touchmove", [point(40, 40), point(70, 70)]);
fire("touchend", [point(40, 40)]); fire("touchend", []);
assert.equal(context.selectedNodeIds.size, 1, "pinch-to-pan transition preserves selection");
select(); fire("touchstart", [point(40, 40)]); fire("touchcancel", []); fire("touchend", []);
assert.equal(context.selectedNodeIds.size, 1, "cancelled touch never clears selection");
select(); fire("touchstart", [point(40, 40)], true); fire("touchend", [], true);
assert.equal(context.selectedNodeIds.size, 1, "tapping a node does not clear it through the viewport");

// Rebinding failed downloads clears stale managed URIs, preserving original local media.
const start = source.indexOf("export function bindAndroidPlannerDisplayPreviews(");
const end = source.indexOf("\nexport function switchPlannerMode", start);
context.isAndroidNative = () => true;
context.assertActivePlannerSyncTarget = ({ expectedProjectId }) => { assert.equal(expectedProjectId, "p"); };
context.board.nodes = [{ id: "a", type: "image", assetId: "a", uri: "file:///data/files/Mori/Sync/Images/a/old.jpg" },
  { id: "b", type: "image", assetId: "b", path: "/storage/Pictures/original.jpg" }];
context.renderPlanner = () => {};
vm.runInContext(source.slice(start, end).replace("export function", "function") + "\nglobalThis.bind = bindAndroidPlannerDisplayPreviews;", context);
context.bind([], { resetSyncedImages: true, expectedProjectId: "p" });
assert.equal(context.board.nodes[0].uri, ""); assert.equal(context.board.nodes[1].path, "/storage/Pictures/original.jpg");
context.bind([{ nodeId: "a", assetId: "a", uri: "file:///new.jpg" }], { expectedProjectId: "p" });
assert.equal(context.board.nodes[0].uri, "file:///new.jpg");
console.log("PASS: blank touch deselection, jitter, drag, pinch, cancellation and scoped preview rebinding");
