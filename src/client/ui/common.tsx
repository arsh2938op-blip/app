/** Small shared UI helpers. */

import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  msg: string;
  kind: "ok" | "err";
}

export function useToast(): [Toast | null, (msg: string, kind?: "ok" | "err") => void] {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<number>();

  const show = useCallback((msg: string, kind: "ok" | "err" = "ok") => {
    setToast({ msg, kind });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToast(null), 2800);
  }, []);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  return [toast, show];
}

export function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour12: false });
}
