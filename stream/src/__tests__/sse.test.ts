import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type http from 'node:http';
import { SseClient } from '../sse.js';

function fakeRes() {
  const r = Object.assign(new EventEmitter(), {
    writableLength: 0, written: [] as string[], ended: false, destroyed: false,
    write(s: string) { this.written.push(s); return true; },
    end() { this.ended = true; },
    destroy() { this.destroyed = true; },
  });
  return r;
}

describe('SseClient', () => {
  it('frames events, ids, comments and retry hints', () => {
    const res = fakeRes();
    const c = new SseClient(res as unknown as http.ServerResponse, { maxBufferBytes: 100, onDrop: () => {} });
    c.send('x'); c.send('y', 5); c.comment(''); c.comment('hb'); c.retry(1234);
    expect(res.written).toEqual(['data: x\n\n', 'id: 5\ndata: y\n\n', ':\n\n', ': hb\n\n', 'retry: 1234\n\n']);
  });
  it('drops a slow client whose buffer exceeds the bound', () => {
    const res = fakeRes(); const drops: string[] = [];
    const c = new SseClient(res as unknown as http.ServerResponse, { maxBufferBytes: 100, onDrop: r => drops.push(r) });
    res.writableLength = 101;
    c.send('x'); c.send('y');
    expect(drops).toEqual(['slow']);
    expect(res.destroyed).toBe(true);
    expect(res.written).toEqual([]);
  });
  it('reports a client disconnect once', () => {
    const res = fakeRes(); const drops: string[] = [];
    const c = new SseClient(res as unknown as http.ServerResponse, { maxBufferBytes: 100, onDrop: r => drops.push(r) });
    res.emit('close'); res.emit('close'); c.send('x');
    expect(drops).toEqual(['client']);
    expect(res.written).toEqual([]);
  });
  it('close ends the response and reports a drain drop', () => {
    const res = fakeRes(); const drops: string[] = [];
    const c = new SseClient(res as unknown as http.ServerResponse, { maxBufferBytes: 100, onDrop: r => drops.push(r) });
    c.close(); res.emit('close');
    expect(res.ended).toBe(true);
    expect(drops).toEqual(['drain']);
  });
});
