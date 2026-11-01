/** Places a phone call. The web version opens a `tel:` link; a native wrapper calls the platform dialler. */
export interface DiallerAdapter {
  dial(number: string): void;
}

export class InvalidPhoneNumberError extends Error {
  constructor(number: string) {
    super(`not a dialable number: ${number}`);
    this.name = 'InvalidPhoneNumberError';
  }
}

const DIALLABLE = /^\+?[0-9]{3,15}$/;

/** `tel:` URL for a number made of digits with an optional leading plus. Throws for anything else. */
export function telUrl(number: string): string {
  if (!DIALLABLE.test(number)) throw new InvalidPhoneNumberError(number);
  return `tel:${number}`;
}

/** Web dialler. `navigate` is injected so it can be tested; in the browser pass `(url) => location.assign(url)`. */
export function createWebDialler(navigate: (url: string) => void): DiallerAdapter {
  return { dial: (number) => navigate(telUrl(number)) };
}
