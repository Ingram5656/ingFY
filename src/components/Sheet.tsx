import { useEffect, type ReactNode } from "react";

interface Props {
  title: string;
  subtitle?: string;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}

/** 居中弹出的液态玻璃面板，背后变暗变模糊；点背景或按 Esc 关闭 */
export function Sheet({ title, subtitle, wide, onClose, children }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className={`sheet glass${wide ? " sheet--wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
        <header className="sheet-head">
          <div>
            <strong>{title}</strong>
            {subtitle && <span>{subtitle}</span>}
          </div>
          <button className="nl-close" aria-label="关闭" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
