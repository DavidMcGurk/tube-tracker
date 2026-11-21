function ExternalLink({ href, children }: { href: string; children: string }) {
  return <a className="underline" href={href} target="_blank" rel="noreferrer">{children}</a>;
}

export function SettingsView({ onResetRequest }: { onResetRequest: () => void }) {
  return (
    <main className="mx-auto max-w-3xl px-4 pb-10">
      <div className="space-y-4 rounded-3xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
        <div>
          <h3 className="text-lg font-semibold">Progress</h3>
          <div className="mt-3 flex flex-wrap gap-3">
            <button onClick={onResetRequest} className="rounded-xl bg-red-600 px-4 py-2 text-sm font-medium text-white">Reset progress</button>
          </div>
        </div>

        <div>
          <h3 className="text-lg font-semibold">About</h3>
          <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">
            Tube Tracker uses a local graph model of London transport stations and sections. Your progress is stored only on
            this device (in IndexedDB), and the app keeps working offline after its first successful load.
          </p>
        </div>

        <div>
          <h3 className="text-lg font-semibold">Data sources</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-600 dark:text-slate-300">
            <li>
              Map SVG based on work by <ExternalLink href="https://commons.wikimedia.org/wiki/User:Sameboat">Sameboat</ExternalLink>,
              adapted for this app and licensed under <ExternalLink href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</ExternalLink>.
            </li>
            <li>
              Station and network data from the <ExternalLink href="https://api.tfl.gov.uk/">TfL Unified API</ExternalLink>,
              licensed under the <ExternalLink href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">Open Government Licence v3.0</ExternalLink>.
            </li>
            <li>Reference project: <ExternalLink href="https://github.com/Demianeen/tube-map">Demianeen/tube-map</ExternalLink>.</li>
            <li>
              This is not an official TfL service. See the{' '}
              <ExternalLink href={`${import.meta.env.BASE_URL}licenses/reference-map-LICENCE.txt`}>full attribution and licence notice</ExternalLink>.
            </li>
          </ul>
        </div>
      </div>
    </main>
  );
}
