/**
 * Long requests (photos, voices) run GPU jobs for tens of seconds: when the
 * browser goes away (Stop button, closed tab), the job is cancelled instead
 * of finishing for nobody.
 */
import type { FastifyReply } from 'fastify';

/**
 * Run `task` with a signal aborted when the response closes before it was
 * sent (the client disconnected).
 */
export async function withClientAbort<T>(reply: FastifyReply, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onClose = () => {
    if (!reply.raw.writableEnded) controller.abort(new Error('client disconnected'));
  };
  reply.raw.on('close', onClose);
  try {
    return await task(controller.signal);
  } finally {
    reply.raw.off('close', onClose);
  }
}
