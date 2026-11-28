interface Point {
  x: number;
  y: number;
}

/** Scale and offsets in fractions of the canvas width/height. */
export interface MapViewport extends Point {
  zoom: number;
}

const MAX_ZOOM = 5;
const DRAG_THRESHOLD = 5;

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Keeps the same map point under the cursor or moving pinch midpoint. */
function moveView(view: MapViewport, factor: number, from: Point, to: Point): boolean {
  const zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom * factor));
  const ratio = zoom / view.zoom;
  const x = Math.min(0, Math.max(1 - zoom, to.x - (from.x - view.x) * ratio));
  const y = Math.min(0, Math.max(1 - zoom, to.y - (from.y - view.y) * ratio));
  if (zoom === view.zoom && x === view.x && y === view.y) return false;
  Object.assign(view, { zoom, x, y });
  return true;
}

export function bindMapViewport(
  canvas: HTMLCanvasElement,
  view: MapViewport,
  redraw: () => void,
  onTap: (mapPoint: Point) => void,
): () => void {
  const pointers = new Map<number, Point>();
  let tapOrigin: Point;
  let dragged = false;

  const clientPoint = (event: MouseEvent): Point => ({ x: event.clientX, y: event.clientY });
  const toCanvas = (point: Point, rect: DOMRect): Point => ({
    x: (point.x - rect.left - canvas.clientLeft) / canvas.clientWidth,
    y: (point.y - rect.top - canvas.clientTop) / canvas.clientHeight,
  });
  const wheel = (event: WheelEvent) => {
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.clientHeight : 1);
    const anchor = toCanvas(clientPoint(event), canvas.getBoundingClientRect());
    if (moveView(view, Math.exp(-delta * 0.002), anchor, anchor)) redraw();
  };
  const down = (event: PointerEvent) => {
    if (event.button !== 0 || (event.pointerType !== 'touch' && pointers.size > 0)) return;
    const point = clientPoint(event);
    if (!pointers.size) {
      tapOrigin = point;
      dragged = false;
    } else {
      dragged = true;
    }
    pointers.set(event.pointerId, point);
    canvas.setPointerCapture(event.pointerId);
  };
  const move = (event: PointerEvent) => {
    const previous = pointers.get(event.pointerId);
    if (!previous) return;
    const point = clientPoint(event);
    const before = pointers.size > 1 ? Array.from(pointers.values()).slice(0, 2) : null;
    pointers.set(event.pointerId, point);
    const rect = canvas.getBoundingClientRect();
    if (before) {
      const [a, b] = pointers.values();
      const factor = distance(a, b) / Math.max(1, distance(before[0], before[1]));
      if (moveView(view, factor, toCanvas(midpoint(before[0], before[1]), rect), toCanvas(midpoint(a, b), rect))) redraw();
      return;
    }
    const origin = dragged ? previous : tapOrigin;
    if (!dragged && distance(point, origin) < DRAG_THRESHOLD) return;
    dragged = true;
    if (moveView(view, 1, toCanvas(origin, rect), toCanvas(point, rect))) redraw();
  };
  const up = (event: PointerEvent) => {
    if (!pointers.delete(event.pointerId) || dragged || distance(clientPoint(event), tapOrigin) >= DRAG_THRESHOLD) return;
    const { x, y } = toCanvas(clientPoint(event), canvas.getBoundingClientRect());
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    onTap({ x: (x - view.x) / view.zoom, y: (y - view.y) / view.zoom });
    redraw();
  };
  const cancel = (event: PointerEvent) => { pointers.delete(event.pointerId); };

  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('pointerdown', down);
  canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', cancel);
  canvas.addEventListener('lostpointercapture', cancel);
  return () => {
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('pointerdown', down);
    canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up);
    canvas.removeEventListener('pointercancel', cancel);
    canvas.removeEventListener('lostpointercapture', cancel);
  };
}
