// Must stay free of DB/API calls so the response is CDN-cacheable; all data is fetched and analysed in the browser.
import HomeClient from './HomeClient';

export const metadata = { title: 'stratum.work — who decides the next block' };

export default function Page() {
  return <HomeClient />;
}
