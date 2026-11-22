// 和 ingclock（番茄钟）联动：读它的状态，给它发命令。真正读写文件的是后端（src-tauri/src/ingclock.rs）。
// ingclock 没开时状态是 null，灵动岛照常只显示音乐。

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type ClockPhase = "focus" | "shortBreak" | "longBreak";

/** 最近一次到点 */
export interface ClockFinished {
  id: number;
  at: number;
  finished: ClockPhase;
  next: ClockPhase;
  /** 走完的是"再专注几分钟"的加时，不算番茄 */
  bonus: boolean;
  /** 下一段已经自动开始了 */
  autoStarted: boolean;
  /** 下一段多少分钟 */
  nextMinutes: number;
  /** 刚走完的这段专注记在哪个任务上 */
  task: string | null;
}

export interface ClockStatus {
  updatedAt: number;
  phase: ClockPhase;
  running: boolean;
  remainingMs: number;
  totalMs: number;
  /** 这一组里已经完成了几轮专注 */
  round: number;
  rounds: number;
  bonus: boolean;
  task: string | null;
  finished: ClockFinished | null;
}

/** 多久问一次后端 */
const POLL_MS = 500;

/** ingclock 现在的状态。enabled 为假时不问，直接是 null */
export function useIngclock(enabled: boolean): ClockStatus | null {
  const [status, setStatus] = useState<ClockStatus | null>(null);
  const last = useRef("");

  useEffect(() => {
    if (!enabled) {
      last.current = "";
      setStatus(null);
      return;
    }
    let alive = true;
    const poll = () =>
      invoke<ClockStatus | null>("ingclock_status")
        .then((s) => {
          if (!alive) return;
          // 每秒都会写一次文件，只有内容真的变了才重画
          const key = s ? JSON.stringify({ ...s, updatedAt: 0 }) : "";
          if (key === last.current) return;
          last.current = key;
          setStatus(s);
        })
        .catch(() => {});
    void poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [enabled]);

  return status;
}

/** 现在还剩多少毫秒：两次读文件之间按本地时间往下推，数字才走得顺 */
export function useClockRemaining(status: ClockStatus | null): number {
  const [now, setNow] = useState(() => Date.now());
  const running = !!status?.running;
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);
  if (!status) return 0;
  if (!status.running) return status.remainingMs;
  return Math.max(0, status.remainingMs - Math.max(0, now - status.updatedAt));
}

/** 给 ingclock 发命令：toggle 暂停 / 继续，skip 跳过这一段，start 开始下一段，extend 再专注几分钟 */
export function clockCommand(cmd: "toggle" | "skip" | "start" | "extend", minutes?: number) {
  return invoke("ingclock_command", { cmd, minutes: minutes ?? null }).catch(() => {});
}

/** "18:42" */
export function clockText(ms: number): string {
  const secs = Math.ceil(ms / 1000);
  return `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
}
