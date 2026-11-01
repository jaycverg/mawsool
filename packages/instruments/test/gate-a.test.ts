/**
 * Gate A: every crisis trigger answer fires with the network stubbed to throw.
 * The stubs count calls, so a caught-and-swallowed network attempt still fails the run.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { INSTRUMENTS } from '@mawsool/types';
import { evaluateCrisis, evaluateCrisisForAnswers, itemCount, scoreInstrument } from '../src';

const networkAttempts: string[] = [];

function blocked(name: string): (...args: unknown[]) => never {
  return function () {
    networkAttempts.push(name);
    throw new Error(`network is stubbed to throw: ${name}`);
  };
}

beforeAll(() => {
  vi.stubGlobal('fetch', blocked('fetch'));
  vi.stubGlobal('XMLHttpRequest', blocked('XMLHttpRequest'));
  vi.stubGlobal('WebSocket', blocked('WebSocket'));
  vi.stubGlobal('EventSource', blocked('EventSource'));
  vi.stubGlobal('navigator', { onLine: false, sendBeacon: blocked('sendBeacon') });
  vi.spyOn(http, 'request').mockImplementation(blocked('http.request'));
  vi.spyOn(http, 'get').mockImplementation(blocked('http.get'));
  vi.spyOn(https, 'request').mockImplementation(blocked('https.request'));
  vi.spyOn(https, 'get').mockImplementation(blocked('https.get'));
  vi.spyOn(net, 'connect').mockImplementation(blocked('net.connect'));
  vi.spyOn(net, 'createConnection').mockImplementation(blocked('net.createConnection'));
  vi.spyOn(tls, 'connect').mockImplementation(blocked('tls.connect'));
  vi.spyOn(dns, 'lookup').mockImplementation(blocked('dns.lookup'));
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Gate A: the network stubs are live', () => {
  it('throws on every network entry point and records the attempt', () => {
    try {
      expect(() => fetch('http://example.invalid')).toThrow(/stubbed/);
      const Xhr = (globalThis as unknown as { XMLHttpRequest: new () => unknown }).XMLHttpRequest;
      expect(() => new Xhr()).toThrow(/stubbed/);
      expect(() => http.request('http://example.invalid')).toThrow(/stubbed/);
      expect(() => net.connect(80, 'example.invalid')).toThrow(/stubbed/);
      expect(networkAttempts).toEqual(['fetch', 'XMLHttpRequest', 'http.request', 'net.connect']);
    } finally {
      networkAttempts.length = 0;
    }
  });
});

describe('Gate A: every trigger answer fires offline', () => {
  it('fires on PHQ-9 item 9 for each of 1, 2 and 3', () => {
    for (const value of [1, 2, 3]) {
      expect(evaluateCrisis({ instrument: 'phq9', itemNumber: 9, value })).toMatchObject({
        triggered: true,
        trigger: 'phq9_item9',
      });
    }
  });

  it('fires on a yes to each of the six C-SSRS screener items', () => {
    for (let itemNumber = 1; itemNumber <= 6; itemNumber++) {
      expect(evaluateCrisis({ instrument: 'cssrs', itemNumber, value: 1 })).toMatchObject({
        triggered: true,
        trigger: 'cssrs',
      });
    }
  });

  it('fires on every stored answer set that contains a trigger answer', () => {
    for (const value of [1, 2, 3]) {
      const answers = [0, 0, 0, 0, 0, 0, 0, 0, value];
      expect(evaluateCrisisForAnswers('phq9', answers).triggered).toBe(true);
    }
    for (let i = 0; i < 6; i++) {
      const answers = [0, 0, 0, 0, 0, 0];
      answers[i] = 1;
      expect(evaluateCrisisForAnswers('cssrs', answers).triggered).toBe(true);
    }
  });

  it('fires on nothing else: no other instrument, item or value', () => {
    const firing: string[] = [];
    for (const instrument of INSTRUMENTS) {
      for (let itemNumber = 1; itemNumber <= itemCount(instrument); itemNumber++) {
        for (const value of [0, 1, 2, 3, 4, 5]) {
          if (evaluateCrisis({ instrument, itemNumber, value }).triggered) {
            firing.push(`${instrument}.${itemNumber}=${value}`);
          }
        }
      }
    }
    // PHQ-9 item 9 fires on 1 to 3; 4 and 5 are out of range for that scale and fail safe, so they fire too.
    const phq9 = [1, 2, 3, 4, 5].map((v) => `phq9.9=${v}`);
    // C-SSRS items fire on 1 (yes) and fail safe on 2 to 5 (invalid).
    const cssrs = Array.from({ length: 6 }, (_, i) => [1, 2, 3, 4, 5].map((v) => `cssrs.${i + 1}=${v}`)).flat();
    expect(new Set(firing)).toEqual(new Set([...phq9, ...cssrs]));
  });

  it('scores offline too', () => {
    expect(scoreInstrument('phq9', [0, 0, 0, 0, 0, 0, 0, 0, 1])).toMatchObject({ total: 1, item9Flag: true });
  });

  it('made no network attempt at all', () => {
    expect(networkAttempts).toEqual([]);
  });
});
