'use client';

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';

type View = { scale: number; x: number; y: number };

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const ZOOM_SENSITIVITY = 0.0015;

/**
 * Chrome-free media viewer used by the task review page.
 *
 * Images: wheel zooms around the pointer, dragging pans while zoomed, and a
 * double click restores the full uncropped image.
 * Videos: native browser controls remain available and the rendered player
 * can be zoomed/panned in the same way as an image.
 */
export default function ReviewZoomableMedia({ src, alt, video = false }: { src: string; alt: string; video?: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragStart = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);
  const [view, setView] = useState<View>({ scale: MIN_SCALE, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);

  const clampOffset = useCallback((x: number, y: number, scale: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return { x, y };
    const maxX = ((scale - 1) * rect.width) / 2;
    const maxY = ((scale - 1) * rect.height) / 2;
    return {
      x: Math.max(-maxX, Math.min(maxX, x)),
      y: Math.max(-maxY, Math.min(maxY, y)),
    };
  }, []);

  useEffect(() => {
    setFailed(false);
    setView({ scale: MIN_SCALE, x: 0, y: 0 });
  }, [src]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const mx = event.clientX - rect.left - rect.width / 2;
      const my = event.clientY - rect.top - rect.height / 2;
      setView((current) => {
        const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * (1 - event.deltaY * ZOOM_SENSITIVITY)));
        if (next <= MIN_SCALE) return { scale: MIN_SCALE, x: 0, y: 0 };
        const mediaX = (mx - current.x) / current.scale;
        const mediaY = (my - current.y) / current.scale;
        return { scale: next, ...clampOffset(mx - mediaX * next, my - mediaY * next, next) };
      });
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [clampOffset]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (view.scale <= MIN_SCALE) return;
    dragStart.current = { px: event.clientX, py: event.clientY, ox: view.x, oy: view.y };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragStart.current;
    if (!start) return;
    const x = start.ox + event.clientX - start.px;
    const y = start.oy + event.clientY - start.py;
    setView((current) => ({ scale: current.scale, ...clampOffset(x, y, current.scale) }));
  };
  const endPointer = () => {
    dragStart.current = null;
    setDragging(false);
  };
  const reset = () => setView({ scale: MIN_SCALE, x: 0, y: 0 });

  const mediaStyle: CSSProperties = {
    display: 'block',
    width: '100%',
    height: '100%',
    maxWidth: 'none',
    maxHeight: 'none',
    objectFit: 'contain',
    userSelect: 'none',
    transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
    transformOrigin: 'center center',
    transition: dragging ? 'none' : 'transform 0.08s ease-out',
  };

  return (
    <div
      ref={containerRef}
      className={`task-media-zoom ${video ? 'task-video-media' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={endPointer}
      onDoubleClick={reset}
      style={{
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: view.scale > MIN_SCALE ? (dragging ? 'grabbing' : 'grab') : 'default',
        touchAction: 'none',
      }}
    >
      {failed ? (
        <div className="task-media-fallback" role="img" aria-label={`${alt} 不可用`}>图片不可用</div>
      ) : video ? (
        <video src={src} controls preload="metadata" playsInline aria-label={alt} style={{ ...mediaStyle, background: '#10151e' }} onError={() => setFailed(true)} />
      ) : (
        <img src={src} alt={alt} draggable={false} style={mediaStyle} onError={() => setFailed(true)} />
      )}
    </div>
  );
}
