import { isAnonymous } from './anonymous';

/** How many requests an anonymous session has refused: zero unless a call site missed its own check. A test seam. */
export const refusedRequests = { count: 0 };

/**
 * The only `fetch` the person app uses. Outside an anonymous session it is the browser's. In one, it refuses every request
 * before anything leaves the phone, so a screen or a background job that forgot to ask whether the session is anonymous still
 * cannot reach the server; it sees the same failure as a phone with no network. A source check (`test/anonymous.test.ts`)
 * fails when any other file in the app names `window.fetch`.
 */
export function deviceFetch(): typeof fetch {
  const guarded = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (isAnonymous()) {
      refusedRequests.count += 1;
      return Promise.reject(new TypeError('An anonymous session makes no network request'));
    }
    return window.fetch(input, init);
  };
  return guarded as typeof fetch;
}
