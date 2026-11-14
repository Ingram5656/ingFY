import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FullScreen from "./views/FullScreen";
import DesktopLyrics from "./views/DesktopLyrics";
import Island from "./views/Island";
import "./styles.css";

// 三个窗口（主窗口、桌面歌词、灵动岛）加载同一个页面，按窗口标签决定显示哪个界面
const label = getCurrentWindow().label;
document.documentElement.dataset.window = label;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{label === "desktop" ? <DesktopLyrics /> : label === "island" ? <Island /> : <FullScreen />}</React.StrictMode>,
);
