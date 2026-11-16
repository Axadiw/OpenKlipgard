import { useRef, useState, useEffect } from 'react';

/**
 * Grid thumbnails use this instead of `<img loading="lazy">`: the attribute
 * was insufficient on its own, because the browser queued every
 * authenticated thumbnail request at once regardless of viewport position.
 */
export function useInView(): [React.RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setInView(true);
        observer.disconnect();
      }
    }, { rootMargin: '200px' });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, inView];
}
