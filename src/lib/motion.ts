import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

/**
 * 交叉淡化：值变化时，旧值再保留 ms 毫秒（标记 leaving），让新旧两层同时做进出动画。
 * 返回的列表按 key 渲染，旧实例不会被重新挂载。
 */
export function useCrossfade<T extends string>(value: T, ms: number): { key: T; leaving: boolean }[] {
  const [items, setItems] = useState<{ key: T; leaving: boolean }[]>([{ key: value, leaving: false }]);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setItems((prev) => [
      ...prev.filter((it) => it.key !== value).map((it) => ({ ...it, leaving: true })),
      { key: value, leaving: false },
    ]);
    const t = window.setTimeout(() => setItems((prev) => prev.filter((it) => !it.leaving)), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return items;
}

/**
 * 苹果风格分段控件的滑块：量出当前选中按钮的位置和宽度，
 * 写到容器的 --thumb-x / --thumb-w 上，由 CSS 里的 .seg-thumb 平滑滑过去。
 *
 * 容器可能被卸载再重新挂上（比如切到唱片再切回来，灯效那条会重建），
 * 所以每次渲染后都检查一下：容器换了或选中项变了，就重新定位。
 */
export function useSegThumb(ref: RefObject<HTMLElement | null>, activeKey: string | null) {
  const last = useRef<{ el: HTMLElement | null; key: string | null; ro: ResizeObserver | null }>({ el: null, key: null, ro: null });

  useLayoutEffect(() => {
    const box = ref.current;
    const st = last.current;
    if (box === st.el && activeKey === st.key) return;
    const place = () => {
      const on = box?.querySelector<HTMLElement>("button.is-on[data-seg]");
      if (!box || !box.isConnected) return;
      if (!on) {
        box.style.setProperty("--thumb-o", "0");
        return;
      }
      // 量到 0 宽说明这一刻还没排好版（比如刚挂上、字体没加载完），下一帧再量，别把滑块缩没了
      if (on.offsetWidth === 0) {
        requestAnimationFrame(place);
        return;
      }
      box.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
      box.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
      box.style.setProperty("--thumb-o", "1");
      // 新容器第一次定位不做动画，之后才打开过渡
      if (!box.classList.contains("thumb-ready")) requestAnimationFrame(() => box.classList.add("thumb-ready"));
    };
    if (box !== st.el) {
      st.ro?.disconnect();
      st.ro = box ? new ResizeObserver(place) : null;
      if (box) st.ro!.observe(box);
    }
    st.el = box;
    st.key = activeKey;
    place();
  });

  useEffect(() => () => last.current.ro?.disconnect(), []);
}

/** 鼠标/键盘一段时间没动就返回 true（ms 毫秒）；paused 时始终为 false。 */
export function useIdle(ms: number, paused: boolean): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (paused) {
      setIdle(false);
      return;
    }
    let t = window.setTimeout(() => setIdle(true), ms);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(t);
      t = window.setTimeout(() => setIdle(true), ms);
    };
    const evs = ["mousemove", "mousedown", "wheel", "keydown", "touchstart", "pointerdown"] as const;
    evs.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      window.clearTimeout(t);
      evs.forEach((e) => window.removeEventListener(e, wake));
    };
  }, [ms, paused]);
  return idle;
}
