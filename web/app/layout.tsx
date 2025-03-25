import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import Navigation from "@/components/Navigation";
import { GlobalMenu } from "@/components/GlobalMenu";
import { GlobalMenuProvider } from "@/components/GlobalMenuContext";
import { DataStreamProvider } from "@/lib/DataStreamContext";
import { BlocksProvider } from "@/lib/BlocksContext";
import { VisualizationProvider } from "@/components/VisualizationContext";

export const metadata: Metadata = {
  title: "Stratum Work",
  description: "Web app that streams realtime mining pool stratum v1 messages to a table. ",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" storageKey="theme-default-dark">
          <DataStreamProvider>
            <BlocksProvider>
              <GlobalMenuProvider>
                <VisualizationProvider>
                  {/* Navigation will be present on all pages */}
                  <Navigation>
                    <GlobalMenu />
                  </Navigation>
                  <div>
                    {children}
                  </div>
                </VisualizationProvider>
              </GlobalMenuProvider>
            </BlocksProvider>
          </DataStreamProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}