// Static text only; routing status is fetched and rendered in the browser.
import DonateClient, { CopyButton } from './DonateClient';

export const metadata = { title: 'stratum.work — donate hashrate' };

const ENDPOINT = 'stratum+tcp://us-east.stratum.work:3333';

export default function Page() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-4 p-4 text-sm">
      <h1 className="text-xl font-semibold">Donate hashrate</h1>
      <ul className="list-disc space-y-1 pl-5 text-gray-700 dark:text-gray-300">
        <li>Full donation: no payouts, no accounts.</li>
        <li>Hashrate is routed to pools we observe so we can see the work miners actually receive; the remainder goes to OCEAN via DATUM.</li>
        <li>Any username works; it appears in the thanks list.</li>
      </ul>
      <div className="rounded border border-gray-200 p-3 dark:border-gray-800">
        <div className="flex flex-wrap items-center gap-2">
          <code className="font-mono text-sm">{ENDPOINT}</code>
          <CopyButton text={ENDPOINT} />
        </div>
        <div className="mt-1 text-[12px] text-gray-500">username: anything · password: anything</div>
      </div>
      <section>
        <h2 className="mb-1 text-sm font-semibold">Live routing</h2>
        <DonateClient />
      </section>
    </main>
  );
}
