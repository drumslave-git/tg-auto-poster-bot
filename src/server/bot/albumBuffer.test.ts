import type { Message } from 'grammy/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bufferAlbumMessage, clearAlbumBuffers } from './albumBuffer.js';

const FLUSH_DELAY_MS = 1500;

function message(id: number): Message {
  return { message_id: id, date: 0, chat: { id: 1, type: 'private' } } as Message;
}

describe('bufferAlbumMessage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    clearAlbumBuffers();
    vi.useRealTimers();
  });

  it('holds a single message for the flush window before releasing it', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(1), onFlush);

    vi.advanceTimersByTime(FLUSH_DELAY_MS - 1);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith([message(1)]);
  });

  it('collects the whole group into one flush', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(1), onFlush);
    vi.advanceTimersByTime(500);
    bufferAlbumMessage('g1', message(2), onFlush);
    vi.advanceTimersByTime(500);
    bufferAlbumMessage('g1', message(3), onFlush);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(onFlush).toHaveBeenCalledExactlyOnceWith([message(1), message(2), message(3)]);
  });

  it('restarts the window on every arrival', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(1), onFlush);
    vi.advanceTimersByTime(FLUSH_DELAY_MS - 100);
    bufferAlbumMessage('g1', message(2), onFlush);

    // The first timer would have fired here had it not been cleared.
    vi.advanceTimersByTime(100);
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(onFlush).toHaveBeenCalledOnce();
  });

  it('sorts the group by message id, whatever order Telegram delivered it in', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(3), onFlush);
    bufferAlbumMessage('g1', message(1), onFlush);
    bufferAlbumMessage('g1', message(2), onFlush);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(onFlush.mock.calls[0]?.[0]).toEqual([message(1), message(2), message(3)]);
  });

  it('keeps separate groups apart', () => {
    const first = vi.fn();
    const second = vi.fn();
    bufferAlbumMessage('g1', message(1), first);
    bufferAlbumMessage('g2', message(2), second);

    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    expect(first).toHaveBeenCalledExactlyOnceWith([message(1)]);
    expect(second).toHaveBeenCalledExactlyOnceWith([message(2)]);
  });

  it('starts a fresh buffer for a group that already flushed', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(1), onFlush);
    vi.advanceTimersByTime(FLUSH_DELAY_MS);
    bufferAlbumMessage('g1', message(2), onFlush);
    vi.advanceTimersByTime(FLUSH_DELAY_MS);

    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(onFlush.mock.calls[1]?.[0]).toEqual([message(2)]);
  });

  it('drops pending groups on clear, without flushing them', () => {
    const onFlush = vi.fn();
    bufferAlbumMessage('g1', message(1), onFlush);
    clearAlbumBuffers();

    vi.advanceTimersByTime(FLUSH_DELAY_MS * 2);
    expect(onFlush).not.toHaveBeenCalled();
  });
});
