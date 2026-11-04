import { ToastProvider } from "@/components/Toast.tsx";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
