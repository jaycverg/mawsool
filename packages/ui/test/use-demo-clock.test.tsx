// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { demoOffsetMs, setDemoOffsetMs } from '../src';
import { useDemoClockSync } from '../src/components';

function Probe({ apiUrl }: { apiUrl: string }) {
  const offset = useDemoClockSync(apiUrl);
  return <span data-offset>{offset}</span>;
}

const reply = (offsetMs: number) => vi.fn(async () => new Response(JSON.stringify({ demoMode: true, offsetMs }), { status: 200 }));

describe('useDemoClockSync', () => {
  afterEach(() => {
    cleanup();
    setDemoOffsetMs(0);
    vi.unstubAllGlobals();
  });

  it('asks the API once on mount and re-renders with the offset it is told', async () => {
    const fetcher = reply(1_814_400_000);
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<Probe apiUrl="http://api.test" />);
    await act(async () => undefined);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0]![0])).toBe('http://api.test/clock');
    expect(container.querySelector('[data-offset]')!.textContent).toBe('1814400000');
    expect(demoOffsetMs()).toBe(1_814_400_000);
  });

  it('asks again when the tab becomes visible, and follows the clock when it moved meanwhile', async () => {
    const fetcher = reply(0);
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<Probe apiUrl="" />);
    await act(async () => undefined);
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ demoMode: true, offsetMs: 604_800_000 }), { status: 200 }));
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-offset]')!.textContent).toBe('604800000');
  });

  it('keeps the offset it had when the API cannot be reached', async () => {
    setDemoOffsetMs(86_400_000);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
    const { container } = render(<Probe apiUrl="" />);
    await act(async () => undefined);
    expect(container.querySelector('[data-offset]')!.textContent).toBe('86400000');
  });
});
