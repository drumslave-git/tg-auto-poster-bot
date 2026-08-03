import { describe, expect, it, vi } from 'vitest';
import { notifyDashboard, onDashboardChange } from './events.js';

describe('dashboard change events', () => {
  it('calls every subscriber on notify', () => {
    const first = vi.fn();
    const second = vi.fn();
    const offFirst = onDashboardChange(first);
    const offSecond = onDashboardChange(second);

    notifyDashboard();

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    offFirst();
    offSecond();
  });

  it('stops calling a listener once unsubscribed', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);
    off();

    notifyDashboard();

    expect(listener).not.toHaveBeenCalled();
  });

  it('registers a listener only once', () => {
    const listener = vi.fn();
    const off = onDashboardChange(listener);
    onDashboardChange(listener);

    notifyDashboard();

    expect(listener).toHaveBeenCalledOnce();
    off();
  });

  it('keeps going when a listener throws', () => {
    const boom = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const survivor = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const offBoom = onDashboardChange(boom);
    const offSurvivor = onDashboardChange(survivor);

    expect(() => notifyDashboard()).not.toThrow();

    expect(survivor).toHaveBeenCalledOnce();
    expect(console.error).toHaveBeenCalled();
    offBoom();
    offSurvivor();
  });

  it('is a no-op with nobody listening', () => {
    expect(() => notifyDashboard()).not.toThrow();
  });
});
