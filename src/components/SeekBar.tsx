import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { formatTime } from "../lib/player";

interface Props {
  position: number;
  duration: number;
  /** 拖动过程中实时回报预览位置（null 表示结束拖动），让歌词跟着预览 */
  onPreview: (ms: number | null) => void;
  onSeek: (ms: number) => void;
}

/**
 * 可拖动的进度条。按下即跳到按下的位置开始拖，拖动时只预览不跳转，
 * 松手才真正跳转，避免拖动过程中反复让播放器跳。
 * 键盘：左右方向键前后 5 秒。
 */
export function SeekBar({ position, duration, onPreview, onSeek }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const shown = drag ?? position;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;

  const msAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return ratio * duration;
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const ms = msAt(e.clientX);
    setDrag(ms);
    onPreview(ms);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const ms = msAt(e.clientX);
    setDrag(ms);
    onPreview(ms);
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const ms = msAt(e.clientX);
    setDrag(null);
    onPreview(null);
    onSeek(ms);
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    if (duration <= 0) return;
    if (e.key === "ArrowRight") onSeek(Math.min(duration, position + 5000));
    else if (e.key === "ArrowLeft") onSeek(Math.max(0, position - 5000));
    else return;
    e.preventDefault();
  };

  return (
    <div className={`progress${drag !== null ? " is-dragging" : ""}`}>
      <span>{formatTime(shown)}</span>
      <div
        className="seek"
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration / 1000)}
        aria-valuenow={Math.round(shown / 1000)}
        aria-valuetext={`${formatTime(shown)} / ${formatTime(duration)}`}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={key}
      >
        <div className="track">
          <div className="fill" style={{ width: `${pct}%` }} />
          <div className="knob" style={{ left: `${pct}%` }} />
        </div>
      </div>
      <span>{formatTime(duration)}</span>
    </div>
  );
}
