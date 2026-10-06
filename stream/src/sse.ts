import type http from 'node:http';
import zlib from 'node:zlib';

export class SseClient {
  private closed = false;
  constructor(private res: http.ServerResponse, private opts: { maxBufferBytes: number; onDrop: (reason: string) => void; gzip?: zlib.Gzip }) {
    res.on('close', () => this.drop('client'));
  }
  private drop(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (reason !== 'drain') this.opts.gzip?.destroy();
    this.opts.onDrop(reason);
  }
  private write(s: string) {
    if (this.closed) return;
    const gz = this.opts.gzip;
    if (this.res.writableLength + (gz?.writableLength ?? 0) > this.opts.maxBufferBytes) { this.drop('slow'); this.res.destroy(); return; }
    // Sync flush keeps the deflate dictionary shared across events while delivering each one immediately.
    if (gz) { gz.write(s); gz.flush(zlib.constants.Z_SYNC_FLUSH); } else this.res.write(s);
  }
  send(data: string, id?: number) { this.write((id !== undefined ? `id: ${id}\n` : '') + `data: ${data}\n\n`); }
  comment(text: string) { this.write(text ? `: ${text}\n\n` : ':\n\n'); }
  retry(ms: number) { this.write(`retry: ${ms}\n\n`); }
  close() {
    if (this.closed) return;
    this.drop('drain');
    if (this.opts.gzip) this.opts.gzip.end(); else this.res.end();
  }
}
