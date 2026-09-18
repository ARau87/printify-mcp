import { inspect } from 'node:util';

const REDACTED = '[redacted]';

/**
 * Holds a credential so that printing, logging or serialising it never shows the value.
 * Only the code that sends the credential (the HTTP client) should call `reveal()`.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}
