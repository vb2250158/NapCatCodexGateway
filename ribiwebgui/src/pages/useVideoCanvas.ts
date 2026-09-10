import { computed, onBeforeUnmount, onMounted, ref } from "vue";

type Point = { x: number; y: number };
export function useVideoCanvas() {
  const viewport = ref<HTMLElement>();
  const scale = ref(1);
  const viewportSize = ref({ x: 1200, y: 900 });
  const offset = ref<Point>({ x: 0, y: 0 });
  const positions = ref<Record<string, Point>>({});
  const handMode = ref(false);
  const dragging = ref(false);
  const selectedIds = ref<string[]>(["draft-1"]);
  const marquee = ref<{ x: number; y: number; width: number; height: number }>();
  let selectionStart: Point | undefined;
  let origins: Record<string, Point> = {};
  let gesture: { pointer: number; start: Point; origin: Point; id?: string } | undefined;
  let observer: ResizeObserver | undefined;
  let previousSize: Point | undefined;
  const transform = computed(() => ({ transform: `translate(${offset.value.x}px, ${offset.value.y}px) scale(${scale.value})` }));
  const grid = computed(() => ({ backgroundSize: `${24 * scale.value}px ${24 * scale.value}px`, backgroundPosition: `${offset.value.x}px ${offset.value.y}px` }));

  const minimap = computed(() => {
    const view = { x: -offset.value.x / scale.value, y: -offset.value.y / scale.value, width: viewportSize.value.x / scale.value, height: viewportSize.value.y / scale.value };
    const cards = Object.entries(positions.value).map(([id, p]) => ({ id, x: p.x + 130, y: p.y + 34, width: 380, height: 214 }));
    const left = Math.min(view.x, ...cards.map(p => p.x)) - 100;
    const top = Math.min(view.y, ...cards.map(p => p.y)) - 100;
    const width = Math.max(view.x + view.width, ...cards.map(p => p.x + p.width)) + 100 - left;
    const height = Math.max(view.y + view.height, ...cards.map(p => p.y + p.height)) + 100 - top;
    const factor = Math.min(180 / width, 110 / height);
    const project = (p: { x: number; y: number; width: number; height: number }) => ({ x: (p.x - left) * factor + (180 - width * factor) / 2, y: (p.y - top) * factor + (110 - height * factor) / 2, width: p.width * factor, height: p.height * factor });
    return { cards: cards.map(p => ({ id: p.id, ...project(p) })), view: project(view), left, top, width, height, factor };
  });
  function locateMinimap(x: number, y: number) {
    const map = minimap.value;
    const point = { x: map.left + (x - (180 - map.width * map.factor) / 2) / map.factor, y: map.top + (y - (110 - map.height * map.factor) / 2) / map.factor };
    offset.value = { x: viewportSize.value.x / 2 - point.x * scale.value, y: viewportSize.value.y / 2 - point.y * scale.value };
  }
  function add(id: string) {
    if (positions.value[id]) return;
    const rows = Object.values(positions.value);
    positions.value[id] = { x: rows.length ? Math.max(...rows.map(row => row.x)) + 720 : 0, y: 0 };
  }
  function position(id: string) {
    const point = positions.value[id] || { x: 0, y: 0 };
    return { left: `${point.x}px`, top: `${point.y}px` };
  }
  function zoom(value: number, anchor?: Point) {
    const element = viewport.value;
    if (!element) return;
    const pivot = anchor || { x: element.clientWidth / 2, y: element.clientHeight / 2 };
    const next = Math.max(0.25, Math.min(2, value));
    offset.value = { x: pivot.x - (pivot.x - offset.value.x) * next / scale.value, y: pivot.y - (pivot.y - offset.value.y) * next / scale.value };
    scale.value = next;
  }
  function center(id: string) {
    const element = viewport.value, point = positions.value[id];
    if (!element || !point) return;
    offset.value = { x: element.clientWidth / 2 - (point.x + 320) * scale.value, y: Math.max(30, (element.clientHeight - 620 * scale.value) / 2) - point.y * scale.value };
  }
  function fit() {
    const element = viewport.value, rows = Object.values(positions.value);
    if (!element || !rows.length) return;
    const left = Math.min(...rows.map(row => row.x)), top = Math.min(...rows.map(row => row.y));
    const width = Math.max(...rows.map(row => row.x)) + 640 - left;
    const height = Math.max(...rows.map(row => row.y)) + 620 - top;
    scale.value = Math.max(0.25, Math.min(1, (element.clientWidth - 100) / width, (element.clientHeight - 100) / height));
    offset.value = { x: (element.clientWidth - width * scale.value) / 2 - left * scale.value, y: (element.clientHeight - height * scale.value) / 2 - top * scale.value };
  }
  function begin(event: PointerEvent, id?: string) {
    if (gesture || (event.button !== 0 && event.button !== 1)) return;
    if (id) add(id);
    const targetId = handMode.value || event.button === 1 ? undefined : id;
    event.preventDefault();
    viewport.value?.setPointerCapture(event.pointerId);
    gesture = { pointer: event.pointerId, start: { x: event.clientX, y: event.clientY }, origin: { ...(targetId ? positions.value[targetId]! : offset.value) }, id: targetId };
    origins = Object.fromEntries((targetId ? (selectedIds.value.includes(targetId) ? selectedIds.value : [targetId]) : []).map(key => [key, { ...positions.value[key]! }]));
    dragging.value = true;
  }
  function backgroundDown(event: PointerEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".canvas-minimap,.canvas-tools,.workspace-tools,.output-library,.canvas-menu,.v-overlay")) return;
    if (target.closest(".canvas-object") && event.button !== 1) return;
    begin(event);
    if (event.button === 0 && !handMode.value && gesture) {
      const bounds = viewport.value!.getBoundingClientRect();
      selectionStart = world({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      selectedIds.value = []; dragging.value = false;
      marquee.value = { ...selectionStart, width: 0, height: 0 };
    }
  }
  function move(event: PointerEvent) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (selectionStart) {
      const bounds = viewport.value!.getBoundingClientRect();
      const end = world({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      const box = { x: Math.min(selectionStart.x, end.x), y: Math.min(selectionStart.y, end.y), width: Math.abs(end.x - selectionStart.x), height: Math.abs(end.y - selectionStart.y) };
      marquee.value = box;
      selectedIds.value = Object.entries(positions.value).filter(([,p]) => p.x + 130 < box.x + box.width && p.x + 510 > box.x && p.y + 34 < box.y + box.height && p.y + 248 > box.y).map(([id]) => id);
      return;
    }
    const divisor = gesture.id ? scale.value : 1;
    const point = { x: gesture.origin.x + (event.clientX - gesture.start.x) / divisor, y: gesture.origin.y + (event.clientY - gesture.start.y) / divisor };
    if (gesture.id) {
      for (const [id, origin] of Object.entries(origins)) positions.value[id] = { x: origin.x + point.x - gesture.origin.x, y: origin.y + point.y - gesture.origin.y };
    }
    else offset.value = point;
  }
  function end(event: PointerEvent) {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    gesture = undefined; selectionStart = undefined; marquee.value = undefined; origins = {}; dragging.value = false;
    if (viewport.value?.hasPointerCapture(event.pointerId)) viewport.value.releasePointerCapture(event.pointerId);
  }
  function wheel(event: WheelEvent) {
    const target = event.target as HTMLElement;
    if (target.closest(".composer,.output-library,.canvas-minimap,.canvas-tools,.workspace-tools,.canvas-menu,textarea,.v-overlay")) return;
    event.preventDefault();
    const bounds = viewport.value!.getBoundingClientRect();
    zoom(scale.value * Math.exp(-event.deltaY * 0.0015), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
  }
  function nudge(event: KeyboardEvent, id: string) {
    const steps: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };
    const step = steps[event.key];
    if (!step) return;
    event.preventDefault(); add(id);
    const amount = event.shiftKey ? 50 : 10;
    positions.value[id] = { x: positions.value[id]!.x + step.x * amount, y: positions.value[id]!.y + step.y * amount };
  }
  onMounted(() => {
    observer = new ResizeObserver(() => {
      const element = viewport.value;
      if (!element) return;
      const size = { x: element.clientWidth, y: element.clientHeight };
      if (!previousSize) fit();
      else offset.value = { x: offset.value.x + (size.x - previousSize.x) / 2, y: offset.value.y + (size.y - previousSize.y) / 2 };
      viewportSize.value = size;
      previousSize = size;
    });
    if (viewport.value) observer.observe(viewport.value);
  });
  onBeforeUnmount(() => observer?.disconnect());
  function world(point: Point) { return { x: (point.x - offset.value.x) / scale.value, y: (point.y - offset.value.y) / scale.value }; }
  return { selectedIds, marquee, minimap, locateMinimap, viewport, scale, handMode, dragging, positions, transform, grid, add, position, zoom, center, fit, begin, backgroundDown, move, end, wheel, nudge, world };
}
