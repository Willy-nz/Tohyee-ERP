"use client";

import { useState } from "react";
import { IllustratedIcon, type IllustratedIconName } from "@/components/illustrated-icon";
import { Field } from "@/components/ui";
import styles from "./studio.module.css";

export type Connector = "books" | "csv" | "excel" | "email" | "sqlserver" | "postgres" | "mysql" | "google-analytics" | "google-search-console" | "google-merchant-center" | "google-business-profile" | "google-ads" | "meta" | "shopify";

/** The connectors that read an external database. */
export function isDatabaseConnector(connector: Connector | null): connector is "sqlserver" | "postgres" | "mysql" {
  return connector === "sqlserver" || connector === "postgres" || connector === "mysql";
}

const connectors: { id: Connector; icon: IllustratedIconName; title: string; description: string }[] = [
  { id: "books", icon: "accounting", title: "Books and CRM", description: "Use this organisation’s ledger, invoices, contacts and CRM. Refreshed nightly or on demand." },
  { id: "csv", icon: "csv", title: "CSV file", description: "Connect an export in your analytics folder. Review fields and choose how often to reload." },
  { id: "excel", icon: "spreadsheet", title: "Excel workbook", description: "Choose a sheet from an .xlsx workbook, preview its columns and confirm field types." },
  { id: "email", icon: "mail", title: "Report emails", description: "Collect CSV and Excel attachments from Gmail, Microsoft or IMAP into your analytics folder." },
  { id: "sqlserver", icon: "database", title: "Microsoft SQL Server", description: "Read a table, view or SELECT query from a SQL Server database. Read only; reloaded nightly or on demand." },
  { id: "postgres", icon: "database", title: "PostgreSQL", description: "Read a table, view or SELECT query from a PostgreSQL database. Read only; reloaded nightly or on demand." },
  { id: "mysql", icon: "database", title: "MySQL", description: "Read a table, view or SELECT query from a MySQL database. Read only; reloaded nightly or on demand." },
  { id: "google-analytics", icon: "analytics", title: "Google Analytics", description: "A website's visitors, sessions, pages and traffic sources from a GA4 property. Loaded nightly or on demand." },
  { id: "google-search-console", icon: "search", title: "Google Search Console", description: "How a website does in Google search: searches, clicks, impressions, position, pages, countries and devices. Loaded nightly or on demand." },
  { id: "google-merchant-center", icon: "price", title: "Google Merchant Center", description: "Your products as Google Shopping has them: approved or not, their problems, price and stock as Google sees them, and clicks and impressions by product. Read only; loaded nightly or on demand." },
  { id: "google-business-profile", icon: "location", title: "Google Business Profile", description: "Your Google listing on Search and Maps: views, calls, directions and website clicks by day, reviews and replies, and what people searched for. Read only; needs Google's approval of your Google Cloud project." },
  { id: "google-ads", icon: "coins", title: "Google Ads", description: "Spend, clicks, impressions and conversions by campaign, ad group and keyword each day. Read only; needs Google Ads API access for your Google Cloud project." },
  { id: "shopify", icon: "shop", title: "Shopify", description: "Orders, stock, shop stats, discounts, gift cards and shipments from your connected Shopify stores. Tohyee's own copy; loaded nightly or on demand." },
  { id: "meta", icon: "social", title: "Meta (Facebook and Instagram)", description: "A Facebook Page and its Instagram account: followers, reach, views and engagement by day, each post's figures, and optionally ad spend and results by campaign. Read only; loaded nightly or on demand." },
];

export function ConnectorPicker({ selected, onSelect }: { selected: Connector | null; onSelect: (connector: Connector) => void }) {
  const [search, setSearch] = useState("");
  const matches = connectors.filter((entry) => `${entry.title} ${entry.description}`.toLowerCase().includes(search.toLowerCase().trim()));
  return <section className={styles.connectorSection} aria-label="Choose a connector">
    <div className={styles.sectionHeading}><div><h2>Connect your data</h2><p>Choose a source, check its fields, then use it across your reports.</p></div>
      <Field label="Search connectors"><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Files, books, email…" /></Field>
    </div>
    <div className={styles.connectors}>{matches.map((entry) => <button type="button" className={styles.connector} key={entry.id} aria-pressed={selected === entry.id} onClick={() => onSelect(entry.id)}>
      <span className={styles.connectorIcon} aria-hidden="true"><IllustratedIcon name={entry.icon} /></span><strong>{entry.title}</strong><span>{entry.description}</span><b>Choose connector →</b>
    </button>)}</div>
    {!matches.length ? <p role="status">No connectors match your search.</p> : null}
    <p className={styles.note}>Direct connections to Google Sheets and BigQuery are not available. Use a CSV or Excel export from those services.</p>
  </section>;
}
