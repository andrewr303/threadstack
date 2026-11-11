// "Mac helper" in Settings, Accounts: what it is for, whether it answers, the extension ID to
// give its installer, and the install steps (docs/mac-helper.md).
import React, { useState } from 'react';
import { workspaceApi } from '../workspace/client.js';
import { useOptionalWorkspaceContext } from '../workspace/context.js';
import { useMounted } from './common.js';

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; text: string } | { state: 'failed'; text: string };

function extensionId(): string {
  try {
    return (typeof chrome !== 'undefined' && chrome.runtime?.id) || '';
  } catch {
    return '';
  }
}

export function HelperPanel() {
  const ctx = useOptionalWorkspaceContext();
  const mounted = useMounted();
  const [check, setCheck] = useState<Check>({ state: 'idle' });
  const [copied, setCopied] = useState<string | null>(null);
  const id = extensionId();

  const ping = async () => {
    setCheck({ state: 'busy' });
    // The Mac helper is reached through Chrome's native messaging, an optional permission. The
    // request is the first thing in the click (Chrome only prompts in response to one) and
    // resolves true at once when the permission is already held.
    if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
      let granted = false;
      try {
        granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
      } catch {
        granted = false;
      }
      if (!mounted.current) return;
      if (!granted) {
        setCheck({
          state: 'failed',
          text: 'Chrome did not allow Threadkeeper to talk to the Mac helper. Choose Check connection again and allow it.',
        });
        return;
      }
    }
    const result = await workspaceApi.helperPing();
    if (!mounted.current) return;
    setCheck(
      result.ok
        ? { state: 'ok', text: `Connected (version ${result.version})` }
        : { state: 'failed', text: `Not connected. ${result.error}` }
    );
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id);
      setCopied('Extension ID copied.');
      ctx?.announce('Extension ID copied.');
    } catch {
      setCopied('Copying was blocked. Select the ID above and copy it.');
    }
  };

  return (
    <section className="tk-settings-section tk-acct-helper" aria-labelledby="tk-acct-helper-h">
      <h3 className="tk-settings-h3" id="tk-acct-helper-h">
        Mac helper
      </h3>
      <p className="tk-settings-note">
        Optional. Threadkeeper keeps one account per sign-in signed in inside the workspace at a time. If you need two accounts of
        the same sign-in signed in at the same moment, give the second one its own Chrome window. The Mac helper is a small
        program that opens that window with a separate profile, so its sign-ins never mix with your main browser. It works on
        macOS with Google Chrome and Node.js 22 or newer.
      </p>
      <p className="tk-settings-note">
        The helper does not read, copy or write cookies, passwords or any login data. It only answers two requests: ping, and open
        an address in a profile, on a fixed list of AI sites.
      </p>

      <div className="tk-field-row tk-acct-helper-check">
        <button type="button" className="tk-btn" disabled={check.state === 'busy'} onClick={() => void ping()}>
          {check.state === 'busy' ? 'Checking…' : 'Check connection'}
        </button>
        <span
          className="tk-acct-helper-result"
          role="status"
          aria-live="polite"
          data-ok={check.state === 'ok' ? 'true' : check.state === 'failed' ? 'false' : undefined}
        >
          {check.state === 'ok' || check.state === 'failed' ? check.text : ''}
        </span>
      </div>

      <div className="tk-acct-extid">
        <span className="tk-acct-flabel" id="tk-acct-extid-l">
          Extension ID
        </span>
        <div className="tk-acct-extid-row">
          <code className="tk-acct-extid-code">
            {id || 'Not available here'}
          </code>
          <button type="button" className="tk-btn" disabled={!id} onClick={() => void copy()}>
            Copy extension ID
          </button>
        </div>
        {copied && (
          <p className="tk-acct-help" role="status">
            {copied}
          </p>
        )}
      </div>

      <h4 className="tk-acct-subhead">Install the helper</h4>
      <ol className="tk-acct-steps">
        <li>Copy the extension ID above. It is also on the Threadkeeper card at chrome://extensions.</li>
        <li>
          In the mac-helper folder of Threadkeeper, double-click Install Mac Helper.command. If macOS blocks the file,
          right-click it, choose Open, then confirm.
        </li>
        <li>Paste the extension ID when asked and press Return. The helper is bound to that one extension ID.</li>
        <li>Return here and choose Check connection.</li>
      </ol>
      <p className="tk-settings-note">
        To remove it, double-click Uninstall Mac Helper.command, type REMOVE and press Return. Account profiles and their sign-ins
        are kept.
      </p>
    </section>
  );
}
