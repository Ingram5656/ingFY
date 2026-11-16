import { useRef } from "react";
import { MenuSwitch, useDismiss } from "./MoreMenu";
import { t } from "../lib/i18n";

interface Props {
  onClose: () => void;
  desktop: boolean;
  onDesktop: (v: boolean) => void;
  locked: boolean;
  onLocked: (v: boolean) => void;
  island: boolean;
  onIsland: (v: boolean) => void;
  chat: boolean;
  onChat: (v: boolean) => void;
}

/**
 * 右上角"小窗口"：桌面歌词、灵动岛、聊天模式三个窗口的开关放在一起，像控制中心。
 * 锁定只对桌面歌词有用，所以只在桌面歌词打开时出现在它下面。
 */
export function WindowsMenu(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, ".win-btn", p.onClose);
  return (
    <div className="more-menu win-menu glass glass--thick" ref={ref} role="dialog" aria-label={t("小窗口")}>
      <MenuSwitch label={t("桌面歌词")} sub={t("浮在所有窗口最上面")} on={p.desktop} onChange={p.onDesktop} />
      {p.desktop && (
        <div className="mm-sub">
          <MenuSwitch label={t("锁定")} sub={t("锁定后不能拖动，鼠标可以点穿")} on={p.locked} onChange={p.onLocked} />
        </div>
      )}
      <MenuSwitch label={t("灵动岛")} sub={t("在屏幕顶部显示正在唱的歌词")} on={p.island} onChange={p.onIsland} />
      <MenuSwitch label={t("聊天模式")} sub={t("单独的竖条窗口，大小和长宽比都能拖")} on={p.chat} onChange={p.onChat} />
    </div>
  );
}
