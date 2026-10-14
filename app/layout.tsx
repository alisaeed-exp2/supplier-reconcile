import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AKCC Supplier Reconciliation",
  description: "Reconcile the AKCC Odoo partner ledger against any supplier statement of account.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
