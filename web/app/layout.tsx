import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { GlobalMenuProvider } from "@/components/GlobalMenuContext";
import { DataStreamProvider } from "@/lib/DataStreamContext";
import { BlocksProvider } from "@/lib/BlocksContext";
import { VisualizationProvider } from "@/components/VisualizationContext";
import { TimingDisplayProvider } from "@/components/TimingDisplayContext";
import { HistoricalDataProvider } from "@/lib/HistoricalDataContext";
import { SelectedTemplateProvider } from "@/lib/SelectedTemplateContext";
import { PoolFilterProvider } from "@/components/PoolFilterContext";
import ClientNavigation from "@/components/ClientNavigation";

// Prerendered pages (home, /timing, /sankey, /infra, /v/…) are shells: the data arrives over the stream and the API.
// A short revalidate makes Next send `s-maxage=60, stale-while-revalidate=…` (see expireTime in next.config.mjs)
// instead of its year-long default, so a shared cache in front of the app may hold a shell for a minute, and a new
// deploy's shell replaces it within a minute or so. Request-dependent pages (force-dynamic) stay uncached.
export const revalidate = 60;

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
            <PoolFilterProvider>
            <BlocksProvider>
              <HistoricalDataProvider>
                <SelectedTemplateProvider>
                  <GlobalMenuProvider>
                    <VisualizationProvider>
                    <TimingDisplayProvider>
                      {/* ClientNavigation handles passing the blockHeight to Navigation */}
                      <ClientNavigation>
                        {children}
                      </ClientNavigation>
                    </TimingDisplayProvider>
                    </VisualizationProvider>
                  </GlobalMenuProvider>
                </SelectedTemplateProvider>
              </HistoricalDataProvider>
            </BlocksProvider>
            </PoolFilterProvider>
          </DataStreamProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}