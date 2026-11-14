import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 给"出现 / 消失"的面板补上退场动画：show 变成 false 后先保留 ms 毫秒、加上 is-closing，
 * 由 CSS 播放收起动画，再真正卸载。收起期间显示的是最后一次的内容。
 * 外层 div 是 display: contents，不影响里面元素的定位。
 */
export function Presence({ show, ms = 240, children }: { show: boolean; ms?: number; children: ReactNode }) {
  const last = useRef<ReactNode>(children);
  if (show) last.current = children;
  const [mounted, setMounted] = useState(show);
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (show) {
      setMounted(true);
      setClosing(false);
      return;
    }
    setClosing(true);
    const t = setTimeout(() => {
      setMounted(false);
      setClosing(false);
    }, ms);
    return () => clearTimeout(t);
  }, [show, ms]);

  if (!mounted && !show) return null;
  return <div className={`presence${closing && !show ? " is-closing" : ""}`}>{show ? children : last.current}</div>;
}
