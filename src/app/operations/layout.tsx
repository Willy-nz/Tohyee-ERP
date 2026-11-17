import { AppShell } from "@/components/app-shell";
import { loadPageWorkspace } from "@/lib/auth/page-workspace";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

export default async function OperationsLayout({ children }: LayoutProps<"/operations">) {
  const workspace = await loadPageWorkspace();
  return (
    <AppShell app="accounting" {...workspace}>
      {children}
    </AppShell>
  );
}
