import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type Ref } from "vue";

export const PLAN_DIRECTORY_SIZE = { initial: 360, minimum: 260, collapseBelow: 160, maximum: 600, contentMinimum: 320, step: 20 } as const;

export function directoryMaximum(containerWidth: number): number {
  return Math.max(PLAN_DIRECTORY_SIZE.minimum, Math.min(PLAN_DIRECTORY_SIZE.maximum, containerWidth - PLAN_DIRECTORY_SIZE.contentMinimum - 1));
}

export function directoryWidthFor(requested: number, maximum: number): number {
  if (requested < PLAN_DIRECTORY_SIZE.collapseBelow) return 0;
  return Math.min(maximum, Math.max(PLAN_DIRECTORY_SIZE.minimum, requested));
}

export function directoryKeyboardWidth(key: string, width: number, maximum: number, restored: number): number | null {
  switch (key) {
    case "Home": return 0;
    case "End": return maximum;
    case "Enter": return width ? 0 : directoryWidthFor(restored, maximum);
    case "ArrowLeft": return width <= PLAN_DIRECTORY_SIZE.minimum ? 0 : Math.max(PLAN_DIRECTORY_SIZE.minimum, width - PLAN_DIRECTORY_SIZE.step);
    case "ArrowRight": return width ? Math.min(maximum, width + PLAN_DIRECTORY_SIZE.step) : PLAN_DIRECTORY_SIZE.minimum;
    default: return null;
  }
}

// View-only state: resizing never changes plans, filters, or Manager data.
export function usePlanDirectoryResize(enabled: Ref<boolean>) {
  const layout = ref<HTMLElement | null>(null);
  const preferredWidth = ref<number>(PLAN_DIRECTORY_SIZE.initial);
  const containerWidth = ref(960);
  const compact = ref(false);
  const resizing = ref(false);
  const maximum = computed(() => directoryMaximum(containerWidth.value));
  const width = computed(() => directoryWidthFor(preferredWidth.value, maximum.value));
  const collapsed = computed(() => width.value === 0 && !compact.value);
  let restoredWidth: number = PLAN_DIRECTORY_SIZE.initial;
  let drag: { pointerId: number; startX: number; startWidth: number; original: number; target: HTMLElement } | null = null;
  let observer: ResizeObserver | null = null;
  let media: MediaQueryList | null = null;

  function finish() {
    const previous = drag;
    drag = null;
    resizing.value = false;
    if (previous?.target.hasPointerCapture(previous.pointerId)) previous.target.releasePointerCapture(previous.pointerId);
    if (width.value) restoredWidth = width.value;
  }
  function cancel() {
    if (drag) preferredWidth.value = drag.original;
    finish();
  }
  function start(event: PointerEvent) {
    if (!enabled.value || compact.value || !event.isPrimary || event.button !== 0 || drag) return;
    const target = event.currentTarget as HTMLElement;
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: width.value, original: preferredWidth.value, target };
    resizing.value = true;
  }
  function move(event: PointerEvent) {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    preferredWidth.value = directoryWidthFor(drag.startWidth + event.clientX - drag.startX, maximum.value);
  }
  function end(event: PointerEvent) {
    if (drag?.pointerId !== event.pointerId) return;
    move(event);
    finish();
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape" && drag) { event.preventDefault(); cancel(); return; }
    if (compact.value || !enabled.value || drag) return;
    const next = directoryKeyboardWidth(event.key, width.value, maximum.value, restoredWidth);
    if (next === null) return;
    event.preventDefault();
    if (width.value) restoredWidth = width.value;
    preferredWidth.value = next;
  }
  function updateCompact() {
    compact.value = media?.matches ?? false;
    if (compact.value) cancel();
  }
  function activate() {
    if (observer || !layout.value) return;
    media = window.matchMedia("(max-width: 960px)");
    updateCompact();
    media.addEventListener("change", updateCompact);
    containerWidth.value = layout.value.getBoundingClientRect().width;
    observer = new ResizeObserver(([entry]) => {
      if (entry) containerWidth.value = entry.contentRect.width;
    });
    observer.observe(layout.value);
    window.addEventListener("blur", cancel);
  }
  function deactivate() {
    cancel();
    observer?.disconnect();
    observer = null;
    media?.removeEventListener("change", updateCompact);
    media = null;
    window.removeEventListener("blur", cancel);
  }
  watch(enabled, value => { if (!value) cancel(); });
  onMounted(activate);
  onActivated(activate);
  onDeactivated(deactivate);
  onBeforeUnmount(deactivate);
  return { layout, width, maximum, compact, collapsed, resizing, start, move, end, cancel, finish, keydown };
}
