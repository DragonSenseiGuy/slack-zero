import { getOwnerSession } from '@/lib/auth/require';
import { queueRevision } from '@/lib/queue/revision';
import { runSnoozeSweeps } from '@/lib/snooze/actions';

/**
 * Server-sent events for the inbox: "something changed, re-read the queue".
 *
 * Why this exists: the inbox was a snapshot taken at page load. A DM arriving
 * over Socket Mode, or a snooze elapsing, only became visible on a manual
 * reload — which for a triage tool you leave open all day is the difference
 * between an inbox and a screenshot of one.
 *
 * Why SSE over a poll from the browser: the sweep below has to run *somewhere*
 * for a snooze to elapse at all (it is a sweep, not a per-message timer — see
 * `lib/snooze/actions.ts`), and running it here means one loop wakes items and
 * notifies the tab in the same tick. The client stays a dumb listener.
 *
 * The payload is only a revision string. The client answers it with
 * `router.refresh()`, so the queue is still built exactly once, by the server
 * component, from the same code path as a cold load. Streaming items instead
 * would mean a second serialization of `QueueItem` that could drift from the
 * first.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const POLL_MS = 2_000;
const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  // Checked once at subscribe time. A long-lived stream outliving a sign-out
  // is acceptable: the payload is only a revision string, and the refresh it
  // triggers re-renders the page through `requireOwnerPage()`.
  if (!(await getOwnerSession())) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const send = (event: string, data: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${data}\n\n`),
          );
        } catch {
          // The client went away between the abort signal and this write.
          closed = true;
        }
      };

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer) clearTimeout(timer);
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };

      request.signal.addEventListener('abort', close);

      let lastRevision = '';
      let lastBeat = Date.now();

      const tick = async () => {
        if (closed) return;

        try {
          await runSnoozeSweeps();
        } catch {
        }

        try {
          const revision = await queueRevision();
          if (revision !== lastRevision) {
            const first = lastRevision === '';
            lastRevision = revision;
            send(first ? 'ready' : 'change', revision);
            lastBeat = Date.now();
          } else if (Date.now() - lastBeat >= HEARTBEAT_MS) {
            send('heartbeat', revision);
            lastBeat = Date.now();
          }
        } catch {
        }

        if (!closed) timer = setTimeout(() => void tick(), POLL_MS);
      };

      await tick();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
