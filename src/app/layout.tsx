import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EVOLVE | Autonomous Evolutionary Markets",
  description:
    "A paper-trading evolutionary agent swarm for researching adaptive Solana trading strategies.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
