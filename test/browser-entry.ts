import { Runtime, type StateRequest } from '@herb-tools/client';

import { startStencilBridge } from './stencil-bridge.ts';

// Stand-in for the Stencil element: `value` property reflected to an attribute, emits `update`.
class FakeInput extends HTMLElement {
  static observedAttributes = ['value'];

  #value = '';

  get value() {
    return this.#value;
  }

  set value(next: string) {
    this.#value = next;

    if (this.getAttribute('value') !== next) this.setAttribute('value', next);
  }

  attributeChangedCallback(_name: string, _previous: string | null, next: string | null) {
    this.#value = next ?? '';
  }

  type(text: string) {
    this.value = text;
    this.dispatchEvent(new CustomEvent('update', { detail: text, bubbles: true }));
  }
}

customElements.define('my-input', FakeInput);

class FakeRollup extends HTMLElement {
  options: object | null = null;
}

customElements.define('my-rollup', FakeRollup);

Object.assign(window, {
  harness: {
    standalone() {
      return startStencilBridge();
    },
    herb() {
      const requests: StateRequest[] = [];

      const runtime = Runtime.start({
        state: {
          transport: async (request) => {
            requests.push(request);

            return null;
          },
          debounce: 0,
        },
      });

      const stop = startStencilBridge({ runtime });

      return { requests, runtime, stop };
    },
  },
});
