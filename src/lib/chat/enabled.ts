import type { OrgTx } from "@/lib/db/org-transaction";
import { ValidationError } from "@/lib/errors";

/** Whether Chat is on (TCH1, TCH26). */
export async function teamChatEnabled(tx: OrgTx): Promise<boolean> {
  const found = await tx.query<{ enabled: boolean }>("select enabled from team_chat_settings where id = true");
  return found.rows[0]?.enabled === true;
}

/** While Chat is off, all of it says so; its messages are kept (TCH1, TCH26). */
export async function requireTeamChat(tx: OrgTx): Promise<void> {
  if (!(await teamChatEnabled(tx))) throw new ValidationError("Chat is off. An admin can turn it on under Settings, Modules.");
}
