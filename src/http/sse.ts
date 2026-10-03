/**
 * Helpers to stream a reply to the browser as Server-Sent Events over a
 * POST response (EventSource only supports GET, so the front-end reads the
 * stream with fetch + ReadableStream).
 *
 * Event protocol:
 *   event: token  data: {"text": "..."}
 *   event: done   data: {"messageId": "...", "aborted": false, ...}
 *   event: error  data: {"message": "..."}
 */
import type { OutgoingHttpHeaders } from 'node:http';
import type { FastifyReply, FastifyRequest } from 'fastify';

export type SseSend = (event: 'token' | 'done' | 'error', data: unknown) => void;

/**
 * Take over the raw response, run `task` with an AbortSignal that fires when
 * the client disconnects, and guarantee the stream is always closed.
 *
 * @param mapError converts an exception into a client-safe message.
 */
export async function streamSse(
  request: FastifyRequest,
  reply: FastifyReply,
  task: (send: SseSend, signal: AbortSignal) => Promise<void>,
  mapError: (err: unknown) => string,
): Promise<void> {
  const res = reply.raw;
  const controller = new AbortController();

  // Fires when the browser closes the connection (tab closed, "stop" button).
  const onClose = () => {
    if (!res.writableEnded) controller.abort(new Error('client disconnected'));
  };
  res.on('close', onClose);

  // Fastify must not touch the response anymore: we own it from here.
  reply.hijack();
  // Keep the security headers helmet already set on the reply.
  const inherited: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) inherited[name] = value;
  }
  res.writeHead(200, {
    ...inherited,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send: SseSend = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await task(send, controller.signal);
  } catch (err) {
    request.log.error({ err }, 'streaming reply failed');
    send('error', { message: mapError(err) });
  } finally {
    res.off('close', onClose);
    if (!res.writableEnded) res.end();
  }
}
