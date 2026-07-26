import Link from 'next/link';

/** 404 (plan.md, Phase 8). */
export default function NotFound() {
  return (
    <main className="mx-auto max-w-2xl p-8" data-testid="not-found">
      <h1 className="text-xl font-semibold">Nothing here</h1>
      <p className="mt-2 text-sm text-neutral-600">
        That page does not exist.
      </p>
      <p className="mt-6 text-sm">
        <Link className="underline" href="/inbox">
          Back to the inbox
        </Link>
      </p>
    </main>
  );
}
