import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import FullScreen from "./views/FullScreen";
import DesktopLyrics from "./views/DesktopLyrics";
import "./styles.css";

// 两个窗口加载同一个页面，按窗口标签决定显示哪个界面
const label = getCurrentWindow().label;
document.documentElement.dataset.window = label;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{label === "desktop" ? <DesktopLyrics /> : <FullScreen />}</React.StrictMode>,
);
