# ingfy

液态玻璃风格的动态歌词软件，Windows 版。Tauri 2 + React + Rust。
设计稿：https://claude.ai/artifact/62WyVDKUqAGAv9LWmvqjJj

## 第一次运行

1. 安装这些（装过的跳过）：
   - Rust：https://rustup.rs （安装时选默认的 MSVC 工具链）
   - Visual Studio 2022 的"使用 C++ 的桌面开发"工作负载（你已经装了 VS 2022 的话，在 Visual Studio Installer 里勾上它）
   - Node.js 20 以上，然后运行 `npm install -g pnpm`
   - WebView2：Windows 10/11 一般自带
2. 在这个文件夹里打开终端：
   ```powershell
   pnpm install
   pnpm tauri dev
   ```
   第一次编译 Rust 依赖要几分钟，之后会快很多。
3. 在 Spotify（或网易云、QQ 音乐、浏览器）里放一首歌。主窗口会显示全屏歌词；点右上角的桌面歌词按钮可以打开桌面歌词。

## 打包正式版

```powershell
pnpm install
pnpm tauri build
```

第一次打包要下载 NSIS 并完整编译一遍 Rust（开了 LTO），大概 5~15 分钟。完成后：

- 安装程序：`src-tauri\target\release\bundle\nsis\ingfy_1.0.0_x64-setup.exe`，发给别人用这个
- 免安装程序：`src-tauri\target\release\ingfy.exe`，可以直接双击运行（需要电脑上有 WebView2，Windows 10/11 一般自带）

## 功能（1.0.0）

- 读取正在播放的歌曲和封面（Windows 系统媒体控件 SMTC），Spotify、网易云、QQ 音乐、浏览器都可以；上一首、播放/暂停、下一首、拖动进度
- 歌词：网易云音乐优先（逐字歌词 + 翻译），找不到再用 LRCLIB
- 全屏歌词：逐字卡拉 OK、滚轮翻看、点歌词跳转、闲置自动收起上下栏、无边框全屏
- 唱片模式：转动的黑胶、真实几何的唱臂、拖唱针调进度、自定义唱片外观和标签
- 拾音灯：WASAPI 回环采集 + FFT 实时跳动，灯管、直方图、圆环、声波四种效果，颜色跟随专辑或自定义
- 桌面歌词：KTV 两行交错，可拖动，锁定后鼠标穿透
- Spotify 账号连接（PKCE）与收藏
- 设置：背景、歌词颜色、翻译、灯光亮度与鲜艳度等

## 目录

```
src-tauri/src/
  lib.rs      命令、后台轮询线程、窗口设置
  smtc.rs     读取正在播放、控制播放、跳转（Windows）
  lyrics.rs   歌词源（网易云优先，LRCLIB 兜底）
  audio.rs    WASAPI 回环采集 + FFT，推送频谱给拾音灯
  spotify.rs  Spotify 登录（PKCE）、收藏
  media.rs    前后端共用的数据结构
src/
  lib/player.ts   订阅播放状态、进度插值、拉歌词、专辑取色、跳转
  lib/lrc.ts      LRC / YRC 解析、翻译对齐、当前行与逐字进度
  lib/palette.ts  k-means 封面取色
  lib/settings.ts 设置的保存与同步
  lib/motion.ts   交叉淡化、分段控件滑块、闲置检测
  lib/vinyl.ts    唱片外观与唱臂几何
  components/     拾音灯、滚动歌词、卡拉 OK、唱片、进度条、设置面板
  views/FullScreen.tsx    全屏歌词（主窗口）
  views/DesktopLyrics.tsx 桌面歌词窗口
```

## 接下来

1. 灵动岛窗口
2. 中文字体打包（目前用系统的微软雅黑兜底）
3. 自动更新
