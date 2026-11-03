import { useEffect, useState } from 'react';

export type ToastType = 'success' | 'warn' | 'info';

export interface ToastMessage {
  text: string;
  type: ToastType;
}

export type ShowToast = (toast: ToastMessage) => void;

const TOAST_DURATION_MS = 4000;

/** Single feedback toast that auto-dismisses after a few seconds. */
export function useToast() {
  const [toast, setToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), TOAST_DURATION_MS);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  return { toast, showToast: setToast as ShowToast };
}
