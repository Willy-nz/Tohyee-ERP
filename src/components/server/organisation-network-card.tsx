"use client";

import { useEffect, useState } from "react";
import { Button, Card, Notice, ui } from "@/components/ui";
import { api, errorMessage } from "@/lib/client/api";
import type { OrganisationNetwork } from "@/lib/network/organisation-reach";

/** Server settings: where organisations' own database sources and camera post boxes may make this server connect. */
export function OrganisationNetworkCard() {
  const [network, setNetwork] = useState<OrganisationNetwork | null>(null);
  const [status, setStatus] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    api<{ network: OrganisationNetwork }>("/api/admin/organisation-network")
      .then((result) => setNetwork(result.network))
      .catch((caught: unknown) => setStatus({ tone: "error", text: errorMessage(caught) }));
  }, []);

  async function save(next: Partial<OrganisationNetwork>) {
    try {
      const result = await api<{ network: OrganisationNetwork }>("/api/admin/organisation-network", { method: "PUT", body: next });
      setNetwork(result.network);
      setStatus({ tone: "success", text: "Saved." });
    } catch (caught) {
      setStatus({ tone: "error", text: errorMessage(caught) });
    }
  }

  return (
    <Card title="Connections from organisations">
      <p className={ui.muted}>
        An organisation&apos;s owner or admin can add a database source (Analytics) or a camera post box. These make this server connect
        where they say. If this server hosts organisations you don&apos;t run yourself, keep these limited.
      </p>
      {status ? <Notice tone={status.tone}>{status.text}</Notice> : null}
      {network ? (
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            <strong>The local network</strong> (for example a database on another office computer): {network.localNetwork ? "allowed" : "not allowed"}.{" "}
            <Button variant="secondary" size="small" onClick={() => void save({ localNetwork: !network.localNetwork })}>
              {network.localNetwork ? "Don't allow" : "Allow"}
            </Button>
          </div>
          <div>
            <strong>This computer</strong> (a database installed on the Tohyee server itself): {network.thisComputer ? "allowed" : "not allowed"}.{" "}
            <Button variant="secondary" size="small" onClick={() => void save({ thisComputer: !network.thisComputer })}>
              {network.thisComputer ? "Don't allow" : "Allow"}
            </Button>
          </div>
        </div>
      ) : null}
    </Card>
  );
}
