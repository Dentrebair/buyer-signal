"use client";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

interface ToastItem {
  id: number;
  message: string;
  undo?: () => Promise<void>;
}

const Ctx = createContext<(t: Omit<ToastItem, "id">) => void>(() => {});
export const useToast = () => useContext(Ctx);

// One toast at a time; a new action replaces the previous one. Undo stays open 5 s (§10.2).
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const show = useCallback((t: Omit<ToastItem, "id">) => setToast({ ...t, id: ++seq.current }), []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const undo = async () => {
    if (!toast?.undo) return;
    setBusy(true);
    try {
      await toast.undo();
      setToast(null);
    } catch (e) {
      setToast({ id: ++seq.current, message: `Undo failed: ${(e as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Ctx.Provider value={show}>
      {children}
      <div role="status" aria-live="polite" aria-atomic="true">
        {toast && (
          <div className="toast">
            <span>{toast.message}</span>
            {toast.undo && (
              <button type="button" onClick={undo} disabled={busy}>
                Undo
              </button>
            )}
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
