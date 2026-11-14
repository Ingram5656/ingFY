import { memo, type CSSProperties } from "react";

interface Props {
  text: string;
  /** 本行演唱进度 0~1 */
  progress: number;
}

/**
 * 卡拉 OK 填色。按字拆开，按阅读顺序（从左到右、从上到下）逐字填色，
 * 一行歌词折成两行显示时，也会先唱完第一行再唱第二行。
 *
 * 填色只由 --p（0%~100%）连续驱动，颜色样式从不切换，所以不会闪。
 * 一个字开始唱时加上 .up，播放一次"弹起—冲过头—落定"的上浮动画，
 * 唱过的字停在上浮位置，没唱到的字留在原位。
 */
export const Karaoke = memo(function Karaoke({ text, progress }: Props) {
  const chars = Array.from(text);
  const filled = Math.min(1, Math.max(0, progress)) * chars.length;

  return (
    <span className="karaoke" aria-label={text}>
      {chars.map((ch, i) => {
        const p = Math.min(1, Math.max(0, filled - i));
        const style = { "--p": `${(p * 100).toFixed(1)}%` } as CSSProperties;
        return (
          <span key={i} className={p > 0 ? "kc up" : "kc"} aria-hidden="true" style={style}>
            {ch}
          </span>
        );
      })}
    </span>
  );
});
