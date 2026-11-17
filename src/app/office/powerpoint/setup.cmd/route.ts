import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor } from "@/lib/office/addin";
import { windowsSetupScript } from "@/lib/office/windows-setup";

/**
 * A Windows setup file that adds the PowerPoint add-in to desktop
 * PowerPoint in one go, for PowerPoint without Upload My Add-in. Public
 * like the manifest (it only holds this server's public address), and only
 * while remote access is on with an https address.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  if (!addresses) return Response.json({ error: "Remote access is off, so there's no PowerPoint add-in to install. A server admin can turn it on in the Tohyee server app." }, { status: 404 });
  return new Response(windowsSetupScript(addresses), {
    headers: {
      "content-type": "application/octet-stream",
      "cache-control": "no-cache",
      "content-disposition": 'attachment; filename="tohyee-powerpoint-setup.cmd"',
    },
  });
}
