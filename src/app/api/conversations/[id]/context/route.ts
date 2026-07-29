import {
  InvalidContextRequestError,
  parseContextRequest,
} from '@/lib/queue/context';
import { loadConversationContext } from '@/lib/queue/load';

/**
 * The messages before a given one, for the reading pane's context transcript.
 *
 * A route rather than a server action because this is a read the client drives:
 * it fires on selection and again each time the user scrolls further back, and
 * paging state belongs to the component, not to a page render. History is read
 * from Slack on demand, so backfill only needs to retain queue identities for
 * unread messages rather than copying an entire conversation into Postgres.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(
  request: Request,
  { params }: { params: { id: string } },
): Promise<Response> {
  const url = new URL(request.url);

  let parsed;
  try {
    parsed = parseContextRequest(url.searchParams);
  } catch (error) {
    if (error instanceof InvalidContextRequestError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const page = await loadConversationContext(params.id, parsed);
    if (!page) {
      return Response.json(
        { error: 'No such conversation.' },
        { status: 404 },
      );
    }

    return Response.json(page, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return Response.json(
      { error: `Could not load the conversation: ${detail}` },
      { status: 500 },
    );
  }
}
