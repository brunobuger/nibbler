import { input, select } from '@inquirer/prompts';

import { getActiveCancelSignal } from '../cancel.js';

export async function promptSelect<T>(opts: Parameters<typeof select>[0]): Promise<T> {
  const signal = getActiveCancelSignal();
  return await select<T>(
    ({
      ...opts,
      ...(signal ? { signal } : {}),
    } as any) // `signal` support varies by @inquirer/prompts version; keep runtime behavior.
  );
}

export async function promptInput(opts: Parameters<typeof input>[0]): Promise<string> {
  const signal = getActiveCancelSignal();
  return await input(
    ({
      ...opts,
      ...(signal ? { signal } : {}),
    } as any)
  );
}

