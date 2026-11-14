import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";

/**
 * 缓存清理。缓存有两部分：
 * - 每个窗口记在内存里的东西（歌词、曲库列表、歌单曲目、封面取色），由各自的模块登记进来；
 * - 存在硬盘上的（网页内核缓存的封面图片、下载过的更新安装包），由后端清。
 * 设置、每首歌的歌词偏移、背景图片和登录状态都不算缓存，不会动。
 */
const clearers = new Set<() => void>();
const subs = new Set<() => void>();
let epoch = 0;

/** 登记一份内存缓存的清理办法 */
export function registerCache(clear: () => void) {
  clearers.add(clear);
}

// 主窗口点了"清理"：每个窗口都把自己的内存缓存丢掉
void listen("caches-cleared", () => {
  clearers.forEach((clear) => clear());
  epoch++;
  subs.forEach((fn) => fn());
});

/** 每清理一次就加一。放进 effect 的依赖里，清理后会重新拉取 */
export function useCacheEpoch(): number {
  const [value, setValue] = useState(epoch);
  useEffect(() => {
    const fn = () => setValue(epoch);
    subs.add(fn);
    return () => void subs.delete(fn);
  }, []);
  return value;
}

/** 硬盘上的缓存有多大（字节） */
export function cacheSize(): Promise<number> {
  return invoke<number>("cache_size").catch(() => 0);
}

/** 清理所有缓存。硬盘上那部分是后台清的，清完后端会发 "cache-cleared" */
export async function clearCaches(): Promise<void> {
  await emit("caches-cleared");
  await invoke("clear_cache");
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
