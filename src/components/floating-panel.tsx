import { GripVertical } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

interface PanelPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface FloatingPanelProps {
  readonly id: "trade" | "wallets";
  readonly title: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}

const STORAGE_KEY = "sunder:terminal-floating-panels:v1";
const MIN_TOP = 72;
const EDGE = 8;
let nextZ = 42;

function defaultPosition(id: FloatingPanelProps["id"]): PanelPosition {
  if (typeof window === "undefined") return { x: id === "trade" ? 350 : 690, y: 320, z: id === "trade" ? 40 : 39 };
  const compact = window.innerWidth < 1180;
  if (id === "trade") return { x: compact ? 300 : Math.max(340, Math.round(window.innerWidth * 0.2)), y: Math.max(180, window.innerHeight - 490), z: 40 };
  return { x: compact ? 610 : Math.max(680, Math.round(window.innerWidth * 0.39)), y: Math.max(180, window.innerHeight - 490), z: 39 };
}

function readPosition(id: FloatingPanelProps["id"]): PanelPosition {
  const fallback = defaultPosition(id);
  if (typeof window === "undefined") return fallback;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Record<string, unknown> | null;
    const candidate = parsed?.[id];
    if (!candidate || typeof candidate !== "object") return fallback;
    const record = candidate as Record<string, unknown>;
    if (![record.x, record.y, record.z].every((value) => typeof value === "number" && Number.isFinite(value))) return fallback;
    return { x: Number(record.x), y: Number(record.y), z: Number(record.z) };
  } catch {
    return fallback;
  }
}

function savePosition(id: FloatingPanelProps["id"], position: PanelPosition): void {
  try {
    const current = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, [id]: position }));
  } catch {
    // Private browsing and storage policies must not break terminal controls.
  }
}

function clamp(position: PanelPosition, element: HTMLElement | null): PanelPosition {
  if (typeof window === "undefined" || !element) return position;
  const width = element.offsetWidth;
  return {
    ...position,
    x: Math.round(Math.min(Math.max(EDGE, position.x), Math.max(EDGE, window.innerWidth - width - EDGE))),
    y: Math.round(Math.min(Math.max(MIN_TOP, position.y), Math.max(MIN_TOP, window.innerHeight - 86))),
  };
}

export function resetTerminalPanelLayout(): void {
  try { window.localStorage.removeItem(STORAGE_KEY); } catch { /* Storage can be unavailable. */ }
  window.dispatchEvent(new Event("sunder:reset-terminal-layout"));
}

export function FloatingPanel({ id, title, action, className = "", children }: FloatingPanelProps) {
  const panel = useRef<HTMLElement>(null);
  const frame = useRef<number | undefined>(undefined);
  const positionRef = useRef<PanelPosition>(readPosition(id));
  const [position, setPosition] = useState(positionRef.current);

  const commit = useCallback((next: PanelPosition, persist = false) => {
    const bounded = clamp(next, panel.current);
    positionRef.current = bounded;
    setPosition(bounded);
    if (persist) savePosition(id, bounded);
  }, [id]);

  const bringToFront = useCallback(() => {
    nextZ += 1;
    commit({ ...positionRef.current, z: nextZ }, true);
  }, [commit]);

  useEffect(() => {
    const onReset = () => commit(defaultPosition(id), true);
    const onResize = () => commit(positionRef.current, true);
    window.addEventListener("sunder:reset-terminal-layout", onReset);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("sunder:reset-terminal-layout", onReset);
      window.removeEventListener("resize", onResize);
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
  }, [commit, id]);

  const startDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("[data-panel-control]")) return;
    event.preventDefault();
    bringToFront();
    const origin = positionRef.current;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);

    const move = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      const next = { ...positionRef.current, x: origin.x + nextEvent.clientX - startX, y: origin.y + nextEvent.clientY - startY };
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => commit(next));
    };
    const end = (nextEvent: PointerEvent) => {
      if (nextEvent.pointerId !== pointerId) return;
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      commit({ ...positionRef.current, x: origin.x + nextEvent.clientX - startX, y: origin.y + nextEvent.clientY - startY }, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const moveWithKeyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    const movement: Record<string, readonly [number, number]> = {
      ArrowLeft: [-12, 0], ArrowRight: [12, 0], ArrowUp: [0, -12], ArrowDown: [0, 12],
    };
    const delta = movement[event.key];
    if (!delta) return;
    event.preventDefault();
    bringToFront();
    commit({ ...positionRef.current, x: positionRef.current.x + delta[0], y: positionRef.current.y + delta[1] }, true);
  };

  const style = {
    "--floating-x": `${position.x}px`,
    "--floating-y": `${position.y}px`,
    zIndex: position.z,
  } as CSSProperties;

  return (
    <section ref={panel} className={`terminal-floating-panel terminal-floating-panel--${id} ${className}`.trim()} style={style} onPointerDown={bringToFront}>
      <header className="terminal-floating-panel__handle" onPointerDown={startDrag} onKeyDown={moveWithKeyboard} tabIndex={0} aria-label="Drag panel or use arrow keys to move">
        <div><GripVertical size={15} aria-hidden="true" />{title}</div>
        {action ? <div data-panel-control>{action}</div> : null}
      </header>
      {children}
    </section>
  );
}
