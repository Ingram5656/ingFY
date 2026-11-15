import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type * as React from "react";

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

/**
 * 分段控件里拖动排序（iOS 液态玻璃的手感）：
 * - 按住一个选项横向拖过几个像素，它就"浮起来"：放大一点、变成一颗透亮的玻璃泡，跟着鼠标走，
 *   拖得快时沿移动方向稍微拉长；
 * - 其他选项用弹簧动画让出位置；
 * - 松手后先把新顺序存起来，再用 FLIP 让每个选项从松手时的位置弹到新位置，浮起的那颗缩回原大小。
 * 没拖动就松手还是普通的点击。键盘：焦点在选项上时 Alt+← / Alt+→ 挪一格。
 * 选项元素要带 data-reorder="<id>"。
 */
export function useDragReorder<T extends string>(boxRef: RefObject<HTMLElement | null>, ids: T[], onReorder: (next: T[]) => void) {
  type Drag = {
    id: T;
    el: HTMLElement;
    pointerId: number;
    startX: number;
    active: boolean;
    items: HTMLElement[];
    centers: number[];
    widths: number[];
    from: number;
    to: number;
    lastX: number;
    lastT: number;
    vel: number;
    relax?: ReturnType<typeof setTimeout>;
  };
  const drag = useRef<Drag | null>(null);
  const swallowClick = useRef(false);
  /** 提交新顺序前，每个选项在屏幕上的中心位置；新顺序排好版后从这里弹过去 */
  const flipFrom = useRef<Map<string, number> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>();
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const onReorderRef = useRef(onReorder);
  onReorderRef.current = onReorder;

  const items = () => [...(boxRef.current?.querySelectorAll<HTMLElement>("[data-reorder]") ?? [])];

  /** 回到静止状态：清掉位移，浮起的那颗缩回去；动画走完再让分段滑块回来 */
  const settle = (els: HTMLElement[]) => {
    for (const b of els) {
      b.style.translate = "";
      b.style.scale = "";
      b.classList.remove("is-lifted");
    }
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => boxRef.current?.classList.remove("is-reordering"), 460);
  };

  // 新顺序排好版后：每个选项先瞬间放回松手时的位置，下一帧再用弹簧动画落到新位置
  useLayoutEffect(() => {
    const before = flipFrom.current;
    if (!before) return;
    flipFrom.current = null;
    const els = items();
    for (const b of els) {
      b.style.transition = "none";
      b.style.translate = "";
    }
    for (const b of els) {
      const was = before.get(b.dataset.reorder ?? "");
      if (was == null) continue;
      const r = b.getBoundingClientRect();
      b.style.translate = `${was - (r.left + r.width / 2)}px 0`;
    }
    void boxRef.current?.offsetWidth;
    requestAnimationFrame(() => {
      for (const b of els) b.style.transition = "";
      settle(els);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join("|")]);

  useEffect(() => () => clearTimeout(settleTimer.current), []);

  const commit = (from: number, to: number) => {
    if (from === to) return false;
    const els = items();
    const centers = new Map<string, number>();
    for (const b of els) {
      const r = b.getBoundingClientRect();
      centers.set(b.dataset.reorder ?? "", r.left + r.width / 2);
    }
    flipFrom.current = centers;
    const next = [...idsRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorderRef.current(next);
    return true;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.button !== 0 || drag.current) return;
    const el = e.currentTarget;
    const id = el.dataset.reorder as T | undefined;
    if (!id) return;
    const list = items();
    drag.current = {
      id,
      el,
      pointerId: e.pointerId,
      startX: e.clientX,
      active: false,
      items: list,
      centers: list.map((b) => b.offsetLeft + b.offsetWidth / 2),
      widths: list.map((b) => b.offsetWidth),
      from: list.indexOf(el),
      to: list.indexOf(el),
      lastX: e.clientX,
      lastT: performance.now(),
      vel: 0,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dxRaw = e.clientX - d.startX;
    if (!d.active) {
      if (Math.abs(dxRaw) < 6) return;
      d.active = true;
      d.el.setPointerCapture(e.pointerId);
      clearTimeout(settleTimer.current);
      boxRef.current?.classList.add("is-reordering");
      d.el.classList.add("is-lifted");
    }
    // 只能在这一排里面拖
    const n = d.items.length;
    const left0 = d.centers[0] - d.widths[0] / 2;
    const rightN = d.centers[n - 1] + d.widths[n - 1] / 2;
    const half = d.widths[d.from] / 2;
    const dx = Math.max(left0 + half - d.centers[d.from], Math.min(rightN - half - d.centers[d.from], dxRaw));
    d.el.style.translate = `${dx}px 0`;

    // 拖得快时沿移动方向拉长一点，像一颗液体；停下来就弹回圆润
    const now = performance.now();
    const v = (e.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.vel = d.vel * 0.6 + v * 0.4;
    d.lastX = e.clientX;
    d.lastT = now;
    const stretch = Math.min(0.12, Math.abs(d.vel) * 0.05);
    d.el.style.scale = `${(1.12 + stretch).toFixed(3)} ${(1.12 - stretch * 0.6).toFixed(3)}`;
    clearTimeout(d.relax);
    d.relax = setTimeout(() => {
      if (drag.current === d && d.active) d.el.style.scale = "";
    }, 90);

    // 拖到了第几格：越过别人的中线就和它换位
    const c = d.centers[d.from] + dx;
    let to = d.from;
    // 拖到头时中心正好压在端头那格的中线上，所以带一点余量，不然到不了第一格 / 最后一格
    for (let i = d.from + 1; i < n; i++) if (c > d.centers[i] - 2) to = i;
    for (let i = d.from - 1; i >= 0; i--) if (c < d.centers[i] + 2) to = i;
    d.to = to;
    const gap = n > 1 ? d.centers[1] - d.widths[1] / 2 - (d.centers[0] + d.widths[0] / 2) : 0;
    const room = d.widths[d.from] + gap;
    d.items.forEach((b, i) => {
      if (i === d.from) return;
      let shift = 0;
      if (d.from < to && i > d.from && i <= to) shift = -room;
      if (to < d.from && i >= to && i < d.from) shift = room;
      b.style.translate = shift ? `${shift}px 0` : "";
    });
  };

  const finish = (e: React.PointerEvent<HTMLElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    clearTimeout(d.relax);
    if (!d.active) return;
    swallowClick.current = true;
    setTimeout(() => (swallowClick.current = false), 0);
    d.el.style.scale = "";
    if (cancelled || !commit(d.from, d.to)) settle(d.items);
  };

  /** 拖完松手时浏览器还会补一个 click，吞掉它，免得顺手把拖动的那个选上 */
  const onClickCapture = (e: React.MouseEvent) => {
    if (swallowClick.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    const id = e.currentTarget.dataset.reorder as T | undefined;
    const from = id ? idsRef.current.indexOf(id) : -1;
    const to = from + (e.key === "ArrowLeft" ? -1 : 1);
    if (from < 0 || to < 0 || to >= idsRef.current.length) return;
    e.preventDefault();
    boxRef.current?.classList.add("is-reordering");
    commit(from, to);
  };

  return {
    itemProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (e: React.PointerEvent<HTMLElement>) => finish(e, false),
      onPointerCancel: (e: React.PointerEvent<HTMLElement>) => finish(e, true),
      onLostPointerCapture: (e: React.PointerEvent<HTMLElement>) => finish(e, false),
      onKeyDown,
    },
    onClickCapture,
  };
}
