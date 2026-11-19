import { AppShell } from "@/components/app-shell";
import { loadPageWorkspace } from "@/lib/auth/page-workspace";

// Reads the session/database on every request; never prerender.
export const dynamic = "force-dynamic";

/** Chat is its own app (TCH1): the same sign-in and organisations, its own top bar. */
export default async function ChatLayout({ children }: LayoutProps<"/chat">) {
  const workspace = await loadPageWorkspace();
  return (
    <AppShell app="chat" {...workspace}>
      {children}
    </AppShell>
  );
}
