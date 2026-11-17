import type { Metadata } from "next";
import { BrandMark } from "@/components/brand-mark";
import styles from "@/components/office/office.module.css";
import ui from "@/components/ui.module.css";
import { remoteAccessAddress } from "@/lib/ai/tokens";
import { officeAddressesFor } from "@/lib/office/addin";

export const metadata: Metadata = { title: "Get Tohyee Analytics for PowerPoint" };
export const dynamic = "force-dynamic";

/**
 * A page anyone can open, without signing in, to get this server's PowerPoint
 * add-in: the download and the steps, so an admin can send
 * one link instead of a file and instructions. It shows nothing the manifest
 * doesn't: this server's own address. Using the add-in still needs a Tohyee
 * sign-in.
 */
export default async function GetPowerPointAddinPage() {
  const addresses = officeAddressesFor(await remoteAccessAddress());
  return (
    <main className={styles.panelScreen}>
      <section className={styles.panel}>
        <div className={styles.brand}>
          <BrandMark size={24} />
          <span>Tohyee</span>
        </div>
        <h1 className={styles.title}>Get Tohyee Analytics for PowerPoint</h1>
        {!addresses ? (
          <p>This Tohyee doesn&apos;t offer the PowerPoint add-in at the moment. Whoever runs it can turn on Remote access to offer it.</p>
        ) : (
          <>
            <p>The add-in shows a live Tohyee Analytics report on a slide. You&apos;ll need your Tohyee sign-in to use it.</p>
            <p>
              <a className={`${ui.button} ${ui.primary}`} href={`${addresses.manifestUrl}?download=1`} download="tohyee-powerpoint-addin.xml">
                Download the add-in
              </a>
            </p>
            <p className={styles.quiet}>The file is tohyee-powerpoint-addin.xml. It tells PowerPoint where this Tohyee is, and holds no passwords or keys.</p>
            <h2 className={styles.title}>Add it to PowerPoint</h2>
            <ol>
              <li>Open PowerPoint (Windows, Mac or on the web) and a presentation.</li>
              <li>
                Choose <strong>Home › Add-ins</strong> (it may be <strong>Insert › Add-ins › Get Add-ins</strong>), then <strong>My Add-ins</strong>.
              </li>
              <li>
                Choose <strong>Upload My Add-in</strong>, pick the file you downloaded and choose <strong>Upload</strong>.
              </li>
              <li>
                <strong>Tohyee Analytics</strong> appears on the slide. Sign in, then pick an organisation, a report and a page or tile.
              </li>
            </ol>
            <p className={styles.quiet}>
              No Upload My Add-in? Your work&apos;s Microsoft 365 admin has turned it off. Send them this page: they can add it for everyone in the Microsoft 365 admin center, under Settings › Integrated apps › Upload custom apps › Office Add-in, with this file or its address:
            </p>
            <p className={styles.quiet}>
              <code style={{ wordBreak: "break-all" }}>{addresses.manifestUrl}</code>
            </p>
          </>
        )}
      </section>
    </main>
  );
}
