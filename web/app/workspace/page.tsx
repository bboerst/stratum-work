// Client-rendered: layout lives in the URL (?l=), all data is fetched and analysed in the browser.
import { Suspense } from 'react';
import WorkspaceClient from './WorkspaceClient';

export const metadata = { title: 'stratum.work — workspace' };

export default function Page() {
  return <Suspense><WorkspaceClient /></Suspense>;
}
