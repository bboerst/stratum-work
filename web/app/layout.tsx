import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import Navigation from "@/components/Navigation";
import { GlobalMenu } from "@/components/GlobalMenu";
import { GlobalMenuProvider } from "@/components/GlobalMenuContext";
import { DataStreamProvider } from "@/lib/DataStreamContext";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Stratum Work",
  description: "Web app that streams realtime mining pool stratum v1 messages to a table. ",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <ThemeProvider attribute="class" defaultTheme="dark" storageKey="theme-default-dark">
          <DataStreamProvider>
            <GlobalMenuProvider>
              {/* Navigation will be present on all pages */}
              <Navigation>
                <GlobalMenu />
              </Navigation>
              <div>
                {children}
              </div>
            </GlobalMenuProvider>
          </DataStreamProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}