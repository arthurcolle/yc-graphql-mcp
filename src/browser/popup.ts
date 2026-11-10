const form = document.querySelector<HTMLFormElement>('#pair')!;
const tabSelect = document.querySelector<HTMLSelectElement>('#tab')!;
const configInput = document.querySelector<HTMLTextAreaElement>('#config')!;
const mutationInput = document.querySelector<HTMLInputElement>('#mutations')!;
const status = document.querySelector<HTMLOutputElement>('#status')!;
const connectButton = document.querySelector<HTMLButtonElement>('#connect')!;

async function message(value: unknown) {
  const reply = await chrome.runtime.sendMessage(value);
  if (!reply?.ok) throw new Error(reply?.error ?? 'The extension service worker is unavailable.');
  return reply.data;
}

async function refresh() {
  const tabs = await chrome.tabs.query({ url: 'https://apply.ycombinator.com/*' });
  tabSelect.replaceChildren(
    ...tabs
      .filter((tab) => tab.id !== undefined)
      .map((tab) => {
        const option = document.createElement('option');
        option.value = String(tab.id);
        option.textContent = `Tab ${tab.id}: ${tab.title ?? 'YC application'}`;
        return option;
      }),
  );
  const state = await message({ type: 'status' });
  if (state.tabId !== null) tabSelect.value = String(state.tabId);
  mutationInput.checked = state.allowMutations;
  status.textContent = state.connected
    ? `Connected to tab ${state.tabId}${state.busy ? ' · working' : ''}`
    : state.error || 'Ready to pair';
  if (!tabs.length)
    status.textContent = 'Open apply.ycombinator.com and sign in, then reopen this panel.';
  connectButton.disabled = !tabs.length;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  connectButton.disabled = true;
  void (async () => {
    const config = JSON.parse(configInput.value);
    await message({
      type: 'connect',
      config: {
        url: config.url,
        token: config.token,
        tabId: Number(tabSelect.value),
        allowMutations: mutationInput.checked,
      },
    });
    configInput.value = '';
    status.textContent = `Connected to tab ${tabSelect.value}`;
  })()
    .catch((error) => {
      status.textContent = error instanceof Error ? error.message : 'Pairing failed.';
    })
    .finally(() => {
      connectButton.disabled = false;
    });
});
document.querySelector('#disconnect')!.addEventListener('click', () => {
  void message({ type: 'disconnect' })
    .then(() => {
      status.textContent = 'Disconnected';
    })
    .catch((error) => {
      status.textContent = error.message;
    });
});
void refresh().catch((error) => {
  status.textContent = error.message;
});
