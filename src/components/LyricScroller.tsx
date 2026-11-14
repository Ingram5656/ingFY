import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type WheelEvent } from "react";
import type { LyricLine } from "../lib/types";
import { Karaoke } from "./Karaoke";
import { FitText } from "./FitText";
import { t } from "../lib/i18n";

interface Props {
  lines: LyricLine[];
  /** 当前行，-1 表示还没到第一句 */
  index: number;
  /** 当前行演唱进度 0~1 */
  progress: number;
  /** 点击某一句时跳到这句开始的位置（毫秒） */
  onSeek: (ms: number) => void;
  /** 有翻译时显示在每句下面 */
  showTranslation?: boolean;
}

interface LineProps {
  text: string;
  trans?: string;
  d: number;
  progress: number;
  setRef: (el: HTMLParagraphElement | null) => void;
  onPick: () => void;
}

/**
 * 单行。每一行都用 Karaoke 渲染（唱过的进度 1、没唱的进度 0），
 * 所以一行从"当前"变成"已唱"时，只是颜色、上浮、光晕这些数值在过渡，
 * DOM 结构不变，不会闪。
 */
const Line = memo(function Line({ text, trans, d, progress, setRef, onPick }: LineProps) {
  const active = d === 0;
  const dist = Math.min(Math.abs(d), 4);
  const style = {
    "--scale": active ? 1 : 0.62,
    "--alpha": active ? 1 : Math.max(0.12, 0.42 - (dist - 1) * 0.1),
    "--blur": active ? "0px" : `${Math.min(dist, 3) * 0.6}px`,
    transitionDelay: `${Math.max(0, d) * 40}ms`,
  } as CSSProperties;
  return (
    <FitText
      ref={setRef}
      fitKey={trans ? `${text}\u001f${trans}` : text}
      className={`scroll-line${active ? " is-active" : ""}${trans ? " has-trans" : ""}`}
      style={style}
      role="button"
      tabIndex={0}
      aria-label={t("跳到这句：{text}", { text })}
      onClick={onPick}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <Karaoke text={text} progress={progress} />
      {trans && <span className="scroll-trans">{trans}</span>}
    </FitText>
  );
});

/**
 * 滚动歌词。换行时整列平滑上移，当前行放大变亮；
 * 其他行按离当前行的距离逐级缩小、变暗、变模糊，离得越远动画越晚。
 *
 * 交互：
 * - 鼠标滚轮可以上下翻看歌词；停手 3 秒后自动回到正在唱的那句。
 * - 点任意一句，歌曲跳到这句开始的位置。
 */
export function LyricScroller({ lines, index, progress, onSeek, showTranslation = true }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLParagraphElement | null)[]>([]);
  const setters = useRef<((el: HTMLParagraphElement | null) => void)[]>([]);
  const pickers = useRef<(() => void)[]>([]);
  const onSeekRef = useRef(onSeek);
  onSeekRef.current = onSeek;
  const linesRef = useRef(lines);
  linesRef.current = lines;
  const [offset, setOffset] = useState(0);
  /** 用滚轮手动翻看时的位置；null 表示跟随当前句 */
  const [manual, setManual] = useState<number | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();
  const focus = Math.max(index, 0);

  const measure = useCallback(() => {
    const track = trackRef.current;
    const el = lineRefs.current[focus];
    if (!track || !el) return;
    const viewport = track.parentElement!;
    // 当前行的中线对齐到可视区域 40% 的高度
    const anchor = viewport.clientHeight * 0.4;
    setOffset(anchor - (el.offsetTop + el.offsetHeight / 2));
  }, [focus]);

  useLayoutEffect(measure, [measure, lines, showTranslation]);

  // 字号、版面宽度变了（调字号、切换居中布局）时重新对齐当前句
  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(track);
    ro.observe(track.parentElement!);
    return () => ro.disconnect();
  }, [measure]);

  // 换歌时退出手动模式
  useEffect(() => {
    setManual(null);
  }, [lines]);

  useEffect(() => () => clearTimeout(idleTimer.current), []);

  const backToCurrentLater = () => {
    clearTimeout(idleTimer.current);
    idleTimer.current = setTimeout(() => setManual(null), 3000);
  };

  const onWheel = (e: WheelEvent<HTMLDivElement>) => {
    const track = trackRef.current;
    if (!track) return;
    const viewport = track.parentElement!;
    // 上下各留一点余地：第一句最多滚到可视区中间，最后一句也是
    const max = viewport.clientHeight * 0.4;
    const min = viewport.clientHeight * 0.4 - track.scrollHeight;
    setManual((prev) => Math.min(max, Math.max(min, (prev ?? offset) - e.deltaY)));
    backToCurrentLater();
  };

  // 每行一个固定的回调，避免 memo 的行因为回调变化而每帧重绘
  const setterFor = (i: number) =>
    (setters.current[i] ??= (el) => {
      lineRefs.current[i] = el;
    });
  const pickerFor = (i: number) =>
    (pickers.current[i] ??= () => {
      const t = linesRef.current[i]?.time;
      if (t === undefined || !Number.isFinite(t)) return;
      clearTimeout(idleTimer.current);
      setManual(null);
      onSeekRef.current(t);
    });

  const y = manual ?? offset;
  return (
    <div className={`scroller${manual !== null ? " is-manual" : ""}`} onWheel={onWheel}>
      <div className="scroller-track" ref={trackRef} style={{ transform: `translateY(${y}px)` }}>
        {lines.map((line, i) => (
          <Line
            key={i}
            text={line.text || "♪"}
            trans={showTranslation ? line.trans : undefined}
            d={i - index}
            progress={i < index ? 1 : i > index ? 0 : progress}
            setRef={setterFor(i)}
            onPick={pickerFor(i)}
          />
        ))}
      </div>
    </div>
  );
}
