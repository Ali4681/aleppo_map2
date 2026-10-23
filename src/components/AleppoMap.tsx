'use client';
import { useEffect, useRef } from 'react';
export default function AleppoMap() {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = container.current;
    if (!root) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void import('@/lib/map/engine').then(async ({ mountMap }) => {
      if (controller.signal.aborted) return;
      const cleanup = await mountMap(root, controller.signal);
      if (controller.signal.aborted) cleanup();
      else dispose = cleanup;
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const message = document.createElement('div');
      message.className = 'startup-error';
      message.setAttribute('role', 'alert');
      message.textContent = `تعذر تحميل الخريطة: ${error instanceof Error ? error.message : String(error)}`;
      root.replaceChildren(message);
    });
    return () => { controller.abort(); dispose?.(); };
  }, []);
  return <main ref={container} className="map-root" aria-label="خريطة حلب القديمة ثلاثية الأبعاد" />;
}
