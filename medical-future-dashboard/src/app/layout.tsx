import "~/styles/globals.css";
import "katex/dist/katex.min.css";

import { type Metadata } from "next";
import { Lora } from "next/font/google";
import { TRPCReactProvider } from "~/trpc/react";

export const metadata: Metadata = {
  title: "Omniscient",
  description: "Interactive medical risk forecasting and intervention simulation interface.",
  icons: [{ rel: "icon", url: "/favicon.ico" }],
};

const lora = Lora({
  subsets: ["latin"],
  variable: "--font-lora",
  display: "swap",
});

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={`${lora.variable}`} lang="en">
      <body>
        <TRPCReactProvider>{children}</TRPCReactProvider>
      </body>
    </html>
  );
}
