import { forwardRef, useLayoutEffect, useRef, type HTMLAttributes, type ReactNode } from "react";

/** 字号设置变化时广播这个事件，所有 FitText 重新量一次 */
export const REFIT_EVENT = "ingfy:refit-text";

interface Props extends HTMLAttributes<HTMLParagraphElement> {
  /** 内容变化的标识（一般是这行歌词文本），变了才重新测量 */
  fitKey: string;
  /** 最多缩到 CSS 字号的多少倍 */
  minScale?: number;
  /** 缩到最小还放不下时是否允许换行；false 则保持一行并用省略号截断 */
  wrap?: boolean;
  children: ReactNode;
}

/**
 * 单行自适应字号：优先保持一行，放不下就按比例缩小字号；
 * 缩到 minScale 还放不下（特别长的句子）才允许换行。
 * 字号直接写在元素上，不经过 React 的 style，所以卡拉 OK 每帧重绘不会把它冲掉。
 * 测量用的是布局尺寸，不受外层 transform 缩放影响。
 */
export const FitText = forwardRef<HTMLParagraphElement, Props>(function FitText(
  { fitKey, minScale = 0.6, wrap = true, children, ...rest },
  forwarded,
) {
  const ref = useRef<HTMLParagraphElement | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      el.style.fontSize = "";
      el.style.whiteSpace = "nowrap";
      const base = parseFloat(getComputedStyle(el).fontSize);
      const avail = el.clientWidth;
      const need = el.scrollWidth;
      if (!avail || need <= avail) return;
      const scale = avail / need;
      if (scale >= minScale) {
        el.style.fontSize = `${Math.floor(base * scale * 0.98)}px`;
      } else {
        el.style.fontSize = `${Math.floor(base * minScale)}px`;
        if (wrap) el.style.whiteSpace = "normal";
      }
    };
    fit();
    // 字体加载完成后宽度会变，再量一次
    document.fonts?.ready.then(fit);
    // 只在可用宽度变化时重新计算（高度变化是自己缩字号引起的，忽略，避免循环）
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== lastWidth) {
        lastWidth = el.clientWidth;
        fit();
      }
    });
    ro.observe(el.parentElement ?? el);
    // 设置里调了字号：可用宽度没变，但基准字号变了，也要重新算
    window.addEventListener(REFIT_EVENT, fit);
    return () => {
      ro.disconnect();
      window.removeEventListener(REFIT_EVENT, fit);
    };
  }, [fitKey, minScale, wrap]);

  return (
    <p
      ref={(el) => {
        ref.current = el;
        if (typeof forwarded === "function") forwarded(el);
        else if (forwarded) forwarded.current = el;
      }}
      {...rest}
    >
      {children}
    </p>
  );
});
